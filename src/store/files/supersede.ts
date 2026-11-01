// supersede — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { join } from "node:path";
import { formatLine, parseLine } from "../../core/logfmt/format.ts"
import { fileIdentity, writeAtomic } from "../../core/logfmt/publish.ts"
import { readLines } from "../../core/logfmt/read.ts";
import { withStoreLock, LOCK_WRITE } from "../lock.ts";
import { redactSecrets } from "../secrets.ts";
import { appendMemory } from "./append.ts";
import { memoryFiles } from "./load.ts";
import { snapshotBefore, stampRow } from "./snapshots.ts";

export interface SupersedeFields {
  superseded_by: string;
  reason: string;
  symbol?: string;
  from?: string;
  to?: string;
  entity?: string;
}

// Mark an existing memory as superseded IN PLACE (entry retained, recoverable).
// Idempotent: a second call is a no-op, so no double `superseded_by`.
export async function markSuperseded(ts: string, fields: SupersedeFields, durable?: string[]): Promise<boolean> {
  return (await markManySupersededReport([{ ts, fields }], durable)).marked.length > 0;
}

// Batch supersession (#61): one lock acquisition, one read, one snapshot and
// one publish PER FILE touched - N rows retire as one undo point instead of
// N. decay and the gate's drift/canonical loops used to call markSuperseded
// per row, which meant N full read-modify-write cycles, N undo points, and
// N windows where two runs interleave and each re-pays the other's work.
// Idempotence is unchanged: a row already carrying superseded_by is skipped,
// so a repeat run marks nothing and writes nothing. Duplicate ts entries in
// one batch: the FIRST entry's fields win (mirrors row-by-row first-call-wins).
// Returns the number of rows actually marked.
export async function markManySuperseded(entries: { ts: string; fields: SupersedeFields }[], durable?: string[]): Promise<number> {
  return (await markManySupersededReport(entries, durable)).marked.length;
}

// Same operation, reporting WHICH rows retired rather than how many (#158
// round 3): the write gate needs the ids to keep a durable-mutation ledger,
// because a failed audit line after a persisted retirement must still be able
// to name what actually landed. Skipped-by-the-batch rows (already retired
// out of band) are absent from `marked` — the ledger never claims a retirement
// this call did not perform.
export async function markManySupersededReport(
  entries: { ts: string; fields: SupersedeFields }[],
  // Updated immediately after EACH publish, even if a later file refuses its
  // lock or lock cleanup throws. A rejected promise is not a rollback.
  durable?: string[],
): Promise<{ marked: string[] }> {
  if (entries.length === 0) return { marked: [] };
  const wanted = new Map<string, SupersedeFields>();
  for (const e of entries) if (!wanted.has(e.ts)) wanted.set(e.ts, e.fields);
  const marked: string[] = [];
  for (const file of await memoryFiles()) {
    marked.push(
      ...(await withStoreLock(
        file,
        async () => {
        // #106: identity BEFORE the read, like every other whole-file
        // read-modify-write (#89's contract) - the publish below may retry a
        // Windows handover only while the destination still matches this.
          const since = await fileIdentity(file);
          const lines = await readLines(file);
          const ids: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            const parsed = parseLine(lines[i]);
            if (!parsed || typeof parsed.superseded_by === "string") continue;
            const fields = typeof parsed.ts === "string" ? wanted.get(parsed.ts) : undefined;
            if (!fields) continue;
            // Whole line rewritten, not extended: an old-format line comes out in
            // the current format with its values unchanged (as markSuperseded did).
            // The one exception is SECRET SCRUB (#128, review probe 4): the
            // fields a merge/decay/update copies into the loser's row carry
            // caller-authored prose (the rotation note "key ghp_... rotated"),
            // and content already scrubs at this same boundary (line 260). The
            // durable row must not be the one place a credential survives when
            // the evidence line beside it was cleaned.
            const clean: SupersedeFields = { ...fields };
            for (const k of Object.keys(clean)) {
              const v = (clean as unknown as Record<string, unknown>)[k];
              if (typeof v === "string") (clean as unknown as Record<string, unknown>)[k] = redactSecrets(v);
            }
            lines[i] = formatLine({ ...parsed, ...clean });
            ids.push(parsed.ts as string);
          }
          if (ids.length === 0) return [];
          await snapshotBefore(file);
          await writeAtomic(file, lines.join("\n") + "\n", since);
          durable?.push(...ids);
          return ids;
        },
        LOCK_WRITE,
      ))
    );
  }
  // A ts that appears in several files (should not exist - append mints unique
  // ts) retires in EVERY file here, where the row-by-row loop retired only the
  // first; both are conservation-safe, this one is the more honest tombstone.
  return { marked };
}

// Drop a row's supersession markers IN PLACE (snapshot-first), making it active
// again. Used by memory_merge_review: a declared survivor must be recallable
// even when an earlier row — now the loser — had superseded it first.
export async function clearSuperseded(ts: string): Promise<boolean> {
  for (const file of await memoryFiles()) {
    const outcome = await stampRow(file, ts, (parsed) => {
      if (typeof parsed.superseded_by !== "string") return null;
      // These five keys are written only by markSuperseded (drift, canonical,
      // update and merge_review), never by appendMemory, so they are all part of
      // the marker and go with it. Field order round-trips because parseLine
      // inserts keys in source order.
      for (const key of ["superseded_by", "reason", "symbol", "from", "to", "entity"]) {
        delete parsed[key];
      }
      return formatLine(parsed);
    });
    if (outcome !== null) return outcome;
  }
  return false;
}
