// prune — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { join, basename } from "node:path";
import { parseLine } from "../../core/logfmt/format.ts"
import { fileIdentity, writeAtomic } from "../../core/logfmt/publish.ts"
import { readLines } from "../../core/logfmt/read.ts";
import { withStoreLock, LOCK_WRITE } from "../lock.ts";
import { tombstoneMany } from "../tombstones/tombstone.ts";
import { type DeletedMemory, logDeletion } from "./deletions.ts";
import { memoryFiles, toMemory } from "./load.ts";
import { snapshotFiles } from "./snapshots.ts";
import { type Reader, isVisibleTo, readerForAmbient } from "../model/visibility.ts";

export interface PruneResult {
  deleted: DeletedMemory[];
  snapshot: string[];
}

// Remove matching memories (used by memory_forget), snapshotting first and
// logging every deletion with its reason. Each file is filtered and republished
// under the store lock, so a row another session appended while we were reading
// is not quietly filtered out along with the targets. The reader is the
// caller's captured identity (#127); out-of-plugin callers keep ambient.
export async function prune(
  scope: string,
  type: string,
  reason: string,
  reader: Reader = readerForAmbient(),
  durable: PruneResult = { deleted: [], snapshot: [] },
): Promise<PruneResult> {
  const { deleted, snapshot } = durable;
  for (const file of await memoryFiles()) {
    await withStoreLock(
      file,
      async () => {
        const since = await fileIdentity(file);
        const lines = await readLines(file);
        const kept: string[] = [];
        const fileDeleted: DeletedMemory[] = [];
        let changed = false;
        for (const line of lines) {
          const parsed = parseLine(line);
          const m = parsed ? toMemory(parsed, file, 0) : null;
          // Repo floor: forgetting scope X here must never delete
          // another repo's row for scope X — same basename collisions are real
          // (a fork next to its upstream).
          if (m && m.scope === scope && m.type === type && isVisibleTo(m, reader)) {
            fileDeleted.push({ memory: m, reason });
            await logDeletion(m, reason);
            changed = true;
            continue;
          }
          kept.push(line);
        }
        if (!changed) return;
        snapshot.push(...(await snapshotFiles([file])));
        await writeAtomic(file, kept.join("\n") + (kept.length ? "\n" : ""), since);
        deleted.push(...fileDeleted);
      },
      LOCK_WRITE,
    );
  }
  // #35: tombstone every forgotten VALUE, keyed on content rather than on the
  // row's `ts`, so replaying the source cannot store the fact again.
  //
  // ONE batched call, not one per row: `memory_forget` deletes by scope+type and
  // routinely removes hundreds of rows, and the per-row form issued a store-lock
  // create/unlink pair plus a full re-read of the tombstone file for each one.
  // Done AFTER the per-file locks are released as well — appending inside the
  // loop would nest a second store lock (day file, then rejected.logfmt) inside
  // the first, and one consistent order across the codebase is what keeps the
  // lock manager from having to reason about nesting at all.
  await tombstoneMany(
    deleted.map((d) => ({
      content: d.memory.content,
      scope: d.memory.scope,
      type: d.memory.type,
    })),
    { reason, source: "forget" },
  );
  return { deleted, snapshot };
}
