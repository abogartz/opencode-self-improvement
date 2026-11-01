// export — split from src/portable.ts (#168 domain restructure). Declaration bodies are unchanged.
// Portability: JSONL export/import of the durable store, plus the
// stale-open-thread query that backs memory_decay. Import NEVER writes: every
// row flows through the caller-provided gate callback (index.ts wires it to
// runWriteGate), so moving memories between machines cannot bypass the 4-gate
// moat. Decay is supersede-not-delete and snapshot-first, mirroring prune.
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { allowOutsideStorePaths, exportsDir, memoryRoot } from "../core/config/paths.ts";
import { resolveContained } from "../store/containment.ts";
import { loadAll } from "../store/files/load.ts"
import { isActive } from "../store/model/predicates.ts"
import { isVisibleTo, readerFromSid } from "../store/model/visibility.ts";

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
export function stamp(d: Date = new Date()): string {
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

// Recognize the export header line (see EXPORT_HEADER). A version NEWER than
// we understand does NOT grant the frontier exemption — we cannot know what
// its writer meant (fail closed).
export function exportHeader(line: string): { version: number } | null {
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
