// import — split from src/portable.ts (#168 domain restructure). Declaration bodies are unchanged.
import { open, readFile } from "node:fs/promises";
import { allowOutsideStorePaths, memoryRoot } from "../core/config/paths.ts";
import { resolveContained } from "../store/containment.ts";
import { isQuarantined, quarantineCandidate } from "../store/quarantine/quarantine.ts";
import { UnresolvedWriterError } from "../store/files/append.ts";
import { writeTarget } from "../identity/repokey.ts";
import { getCurrent } from "../core/state.ts";
import { TYPES } from "../core/types.ts";
import type { WriteCandidate } from "../gate/gate.ts";
import { flattenMemoryText } from "../store/sanitize.ts";
import { EXPORT_VERSION, exportHeader, stamp } from "./export.ts";

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
