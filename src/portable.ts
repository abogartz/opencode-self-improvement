// Portability: JSONL export/import of the durable store, plus the
// stale-open-thread query that backs memory_decay. Import NEVER writes: every
// row flows through the caller-provided gate callback (index.ts wires it to
// runWriteGate), so moving memories between machines cannot bypass the 4-gate
// moat. Decay is supersede-not-delete and snapshot-first, mirroring prune.
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { allowOutsideStorePaths, exportsDir, memoryRoot } from "./config.ts";
import { resolveContained } from "./containment.ts";
import { isQuarantined, quarantineCandidate } from "./quarantine.ts";
import {
  isActive,
  isInjectable,
  isVisibleTo,
  loadAll,
  readerFromSid,
  UnresolvedWriterError,
  type Memory,
} from "./memory.ts";
import { writeTarget } from "./repokey.ts";
import { getCurrent } from "./state.ts";
import { TYPES } from "./types.ts";
import type { WriteCandidate } from "./gates.ts";
import { flattenMemoryText } from "./sanitize.ts";

// --- export -------------------------------------------------------------------

// Export header line: the first line of a v1 export identifies the file as
// machine-made by memory_export. It is what vouches for status="open" frontier
// rows on import — the open status exempts a row from ref grounding at the
// gate, so it must not be granted by an attacker-chosen field in a
// hand-written JSONL. The header is friction, not a boundary (anyone can
// paste one); the real defense against planted content is the injection
// framing + provenance in inject.ts and the write gates.
export const EXPORT_HEADER = "opencode-self-improvement";
export const EXPORT_VERSION = 1;

export interface ExportOptions {
  /** Only export rows from this exact scope. */
  scope?: string;
  /**
   * Destination, confined to <memory-root>/exports/ (see containment.ts).
   * Defaults to <memory-root>/exports/<stamp>-<unique>.jsonl: a UNIQUE name,
   * created exclusively, so two exports in the same second can never replace
   * each other's artifact (#143's review). An explicit `file` keeps the
   * historical replace semantics backups rely on.
   */
  file?: string;
  /**
   * The calling session's identity (#143): an export carries exactly the rows
   * its reader can read — own repo plus global. "?" or absent resolves the
   * AMBIENT reader: out-of-plugin callers (viewer, CLI maintenance) keep the
   * full-store breadth; breadth stays a property of the entry point.
   */
  sessionID?: string;
}

export interface ExportResult {
  path: string;
  count: number;
}

// Filesystem-safe YYYY-MM-DDTHHMMSS (no colons) plus a unique suffix for each
// default export. The timestamp alone was second-granular: two sessions
// exporting in the same second got the SAME path, and O_TRUNC let the later
// one destroy the earlier one's artifact AND its returned path (#143 review).
// Milliseconds would still collide; uniqueness comes from the name, not the
// clock.
function stamp(d: Date = new Date()): string {
  return `${d.toISOString().slice(0, 19).replace(/:/g, "")}-${randomUUID()}`;
}

// An export is a full copy of the live store, so it may only be written inside
// the store's own exports/ directory: ~/.gitconfig, a relative path landing in
// the host process's cwd, ../.., and links out of the root are all rejected.
// Only an absent `file` means the default — an empty or whitespace-only one is
// a caller bug and fails rather than silently redirecting.
async function resolveExportTarget(file: string | undefined): Promise<string> {
  const allowOutside = allowOutsideStorePaths();
  const opts = {
    label: "memory_export file",
    hint: `omit file for the default, or name a path under ${exportsDir()}`,
    // An exports/ that is itself a symlink must not move the write out of the
    // store either — same two-level check undo.ts's restore makes.
    outerRoot: memoryRoot(),
    allowOutside,
  };
  // A default destination is still a destination. Routing it through the same
  // check is what stops an exports/ that is a link from writing the whole store
  // copy outside the store on the argument-free call — the one a model reaches
  // without knowing anything about the layout. Under the operator escape hatch
  // there is nothing to check, so the plain join is what remains.
  if (file === undefined && allowOutside) return join(exportsDir(), `${stamp()}.jsonl`);
  return resolveContained(file ?? `${stamp()}.jsonl`, exportsDir(), opts);
}

// An export is a plaintext copy of the whole store, so it is written 0600 and
// opened O_NOFOLLOW. The flag matters: the containment check and this open are
// separate syscalls, and the gap is the entire store read — single-digit to tens
// of milliseconds on a 5 000-row store depending on the machine, which is long
// enough for anything that can create a link inside exports/.
//
// Both are POSIX guarantees. libuv does not implement O_NOFOLLOW on Windows
// (verified on the CI windows leg: the open follows the link) and Windows
// reports every writable file as 0666, so there the containment check that ran
// before this call is the only protection.
//
// Exported so the flag itself can be pinned: the containment layer refuses an
// existing link long before this runs, so the only way to test O_NOFOLLOW
// without racing is to call the writer directly.
export async function writeExport(path: string, text: string, exclusive = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // exclusive = a default destination WE chose: create it or fail, never
  // silently replace another export's file. An explicit caller-supplied
  // `file` keeps the historical O_TRUNC replace (backup workflows rewrite
  // the same path on purpose).
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    (exclusive ? constants.O_EXCL : constants.O_TRUNC) |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(text, "utf8");
    // open()'s mode applies only when the file is created, so re-exporting over
    // a file that already existed (a 0644 one, say) would otherwise leave it
    // world-readable and make the 0600 above a claim rather than a guarantee.
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

// Write the ACTIVE store as JSONL — a header line followed by one JSON object
// per line carrying {ts,type,scope,content,status,tags,issue}. Superseded rows
// are not exported: the export is the live store, and history stays auditable
// where it lives (the original logfmt files + snapshots). The header is always
// written, even for an empty store, so "has header" is a format invariant.
//
// "the live store" means the store AS THE CALLER CAN READ IT (#143): rows are
// filtered through the caller's Reader, exactly as recall and injection do.
// Full breadth remains the ambient/admin entry point's, never a missing
// session's.
//
// The destination is model-supplied, so it is resolved and confined BEFORE the
// store is read: a rejected export must not leave a file behind, and must not
// be a way to learn how many rows matched either.
export async function exportMemories(opts: ExportOptions = {}): Promise<ExportResult> {
  const path = await resolveExportTarget(opts.file);
  const reader = readerFromSid(opts.sessionID);
  let mems = (await loadAll()).filter(isActive).filter((m) => isVisibleTo(m, reader));
  if (opts.scope) mems = mems.filter((m) => m.scope === opts.scope);
  const header = JSON.stringify({
    _export: EXPORT_HEADER,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    count: mems.length,
  });
  const lines = mems.map((m) =>
    JSON.stringify({
      ts: m.ts,
      type: m.type,
      scope: m.scope,
      content: m.content,
      status: m.status,
      tags: m.tags,
      kw: m.kw,
      issue: m.issue,
      // Origin stamps ride along so a same-repo machine hop can retain them.
      // Import validates them against its current repo before promotion.
      repo: m.repo,
      repoPath: m.repoPath,
    }),
  );
  try {
    await writeExport(path, `${[header, ...lines].join("\n")}\n`, opts.file === undefined);
  } catch (err) {
    // Past containment, so this is not an existence oracle: `path` is one the
    // plugin chose or already validated. The errno stays, because it is the
    // operator's only diagnostic — but in our sentence rather than the runtime's,
    // so a model-facing tool result never carries a raw stack-adjacent string.
    const code = err instanceof Error && "code" in err ? String(err.code) : "unknown error";
    throw new Error(`memory_export could not write ${path} (${code})`);
  }
  return { path, count: mems.length };
}

// --- import -------------------------------------------------------------------

export interface ImportTally {
  promoted: number;
  quarantined?: number;
  collapsed: number;
  blocked: number;
  skipped: number;
  /** Open rows downgraded because the file cannot grant that frontier scope. */
  downgraded: number;
  /** Promoted rows whose write_promoted audit line failed to land (#155 review). */
  unaudited: number;
  /** First audit-fault message, so the reply can name what went wrong. */
  auditError?: string;
}

// Recognize the export header line (see EXPORT_HEADER). A version NEWER than
// we understand does NOT grant the frontier exemption — we cannot know what
// its writer meant (fail closed).
function exportHeader(line: string): { version: number } | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (r._export !== EXPORT_HEADER) return null;
  return { version: typeof r.version === "number" ? r.version : 1 };
}

// A line is malformed (skipped, never gated) unless it is a JSON object with a
// known type, a non-empty scope, and non-empty content. Optional fields are
// sanitized rather than fatal where noted. Control characters in structured
// metadata make the row malformed; content alone may remain multiline.
function parseRow(line: string): WriteCandidate | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.type !== "string" || !(TYPES as readonly string[]).includes(r.type)) return null;
  if (typeof r.scope !== "string" || !r.scope.trim()) return null;
  if (flattenMemoryText(r.scope) !== r.scope) return null;
  if (typeof r.content !== "string" || !r.content.trim()) return null;
  if (
    Array.isArray(r.tags) &&
    r.tags.some((t) => typeof t === "string" && flattenMemoryText(t) !== t)
  ) return null;
  if (typeof r.issue === "string" && flattenMemoryText(r.issue) !== r.issue) return null;
  // Keywords widen recall only, so a malformed entry costs them, never the row
  // (contrast scope/content, where a bad value makes the line malformed).
  const kw = Array.isArray(r.kw)
    ? r.kw.filter(
        (k): k is string =>
          typeof k === "string" && !!k.trim() && flattenMemoryText(k.trim()) === k.trim(),
      )
    : undefined;
  const c: WriteCandidate = { type: r.type, scope: r.scope, content: r.content };
  if (r.status === "open" || r.status === "settled") c.status = r.status;
  if (Array.isArray(r.tags) && r.tags.every((t) => typeof t === "string")) c.tags = r.tags;
  if (kw?.length) c.kw = kw;
  if (typeof r.issue === "string" && r.issue) c.issue = r.issue;
  // Origin stamps survive an export/import hop (repokey.ts): a row written
  // for repo X stays visible only where repo X is opened, even on a new
  // machine. Unstamped rows stay global.
  if (typeof r.repo === "string" && r.repo) c.repo = r.repo;
  if (typeof r.repoPath === "string" && r.repoPath) c.repoPath = r.repoPath;
  return quarantineCandidate(c);
}

// Read a JSONL export and run every valid row through `gate`. The CALLER owns
// promotion (index.ts passes runWriteGate with the "import" tag), so imported
// rows face the same canonical/stale/dedup/ambiguity gates as any other write.
// Blocked and collapsed rows are normal outcomes, tallied rather than raised.
// Frontier policy: status="open" exempts a row from ref grounding
// at the gate, so it is honored ONLY when the file opens with our export
// header (version <= ours); otherwise every open row is downgraded to settled
// and tallied. Imported origin stamps are honored only when they match the
// importing session's current repo (or are an explicit "global"); foreign
// stamps are removed so the write choke point stamps the importing repo
// instead. With no current scope, stamps are kept (removing them would widen
// the row to global) and a stamped open row is downgraded, since its stamp
// cannot be verified. Only a missing file throws.
//
// The path is a model-supplied READ primitive, so it is confined to the memory
// root BEFORE the filesystem is touched, and containment's error never says
// whether the path exists — otherwise a rejection is an existence oracle for
// files outside the store. The .jsonl requirement closes the rest of that door:
// without it, the tally ("N malformed lines skipped") would leak line counts of
// day files, snapshots and the blocklist, none of which are import formats.
export async function importMemories(
  path: string,
  gate: (c: WriteCandidate) => Promise<{ action: string; evidenceError?: string }>,
  // The importing session, captured at tool entry (#127): "the importing
  // session's current repo" must be the CALLER's repo even though this loop
  // awaits the gate on every row, during which a concurrent session can move
  // the ambient current.
  sessionID?: string,
): Promise<ImportTally> {
  // Capture the importing owner before file I/O: later session moves must not
  // re-home rows partway through the import (#183). Resolve with the writer
  // rule so an unresolved named session never borrows the ambient repo (#152).
  const writeAt = writeTarget(sessionID ?? getCurrent().sid);
  const target = await resolveContained(path, memoryRoot(), {
    label: "memory_import file",
    // Deliberately no mention of the operator escape hatch: this string goes
    // back to the model, and naming the variable there is an instruction it can
    // relay. The hatch lives in the README.
    hint: `copy the export under ${memoryRoot()} first`,
    allowOutside: allowOutsideStorePaths(),
  });
  if (!target.toLowerCase().endsWith(".jsonl")) {
    throw new Error(`memory_import file must be a .jsonl export (got "${path}")`);
  }
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`import file not found: ${target}`);
    throw err;
  }
  const tally: ImportTally = { promoted: 0, collapsed: 0, blocked: 0, skipped: 0, downgraded: 0, unaudited: 0 };
  // Preserve file-validation error precedence, but reject an unresolved owner
  // before gating any row. Resolution happened at entry, not at this await.
  if (!writeAt.ok) throw new UnresolvedWriterError(writeAt.sid);
  const currentScope = writeAt.scope;
  let allowFrontier = false;
  let first = true;
  for (const line of text.replace(/^\uFEFF/, "").split("\n")) {
    if (!line.trim()) continue;
    if (first) {
      first = false;
      const hdr = exportHeader(line);
      if (hdr) {
        allowFrontier = hdr.version <= EXPORT_VERSION;
        continue; // metadata line: never a memory row, never a skipped one
      }
    }
    const c = parseRow(line);
    if (!c) {
      tally.skipped++;
      continue;
    }
    const claimedGlobal = c.repo === "global";
    const hadStamp = c.repo !== undefined || c.repoPath !== undefined;
    // A foreign stamp is treated like no stamp, so appendMemory stamps the
    // importing repo. Explicit "global" is not a foreign repo and is kept (open
    // global rows are downgraded below). With no current scope there is nothing
    // to re-stamp with: dropping the stamp would widen the row to global, so it
    // is kept and only the open-row exemption is withdrawn.
    if (currentScope && !claimedGlobal) {
      if (c.repo !== currentScope.key) delete c.repo;
      if (c.repoPath !== currentScope.path) delete c.repoPath;
    }
    if (c.status === "open" && (!allowFrontier || claimedGlobal || (hadStamp && !currentScope))) {
      c.status = "settled";
      tally.downgraded++;
    }
    const outcome = await gate(c);
    if (outcome.action === "promoted") {
      tally.promoted++;
      if (isQuarantined(c)) tally.quarantined = (tally.quarantined ?? 0) + 1;
      if (outcome.evidenceError !== undefined) {
        tally.unaudited++;
        tally.auditError ??= outcome.evidenceError;
      }
    } else if (outcome.action === "collapsed") tally.collapsed++;
    else tally.blocked++;
  }
  return tally;
}

// --- decay support --------------------------------------------------------------

// Active open threads with ts older than `days` days, oldest first (both sides
// are UTC-Z ISO strings, so plain lexicographic compare is correct).
export async function findStaleOpen(days: number, sid?: string): Promise<Memory[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const reader = readerFromSid(sid);
  return (await loadAll())
    // Decay is repo-scoped: running it here must not retire
    // another repo's open threads.
    .filter((m) => isInjectable(m) && isVisibleTo(m, reader) && m.status === "open" && m.ts < cutoff)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
