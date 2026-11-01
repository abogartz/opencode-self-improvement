// The memory_merge_review tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { memoryRoot } from "../config.ts";
import { record } from "../evidence.ts";
import { withStoreLock } from "../lock.ts";
import { clearSuperseded, isVisibleTo, loadAll, markSuperseded, readerFromSid } from "../memory.ts";
import { MergeReviewArgs, validated } from "../schema.ts";
import { join } from "node:path";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, direct } = deps;
    editor.add(validated(MergeReviewArgs, {
      name: "memory_merge_review",
      description:
        "Resolve an open merge/review gate non-destructively: mark the loser as superseded_by the survivor, and clear any supersession the survivor itself carries so the canonical row stays recallable. Both rows stay active data (the loser is recoverable via memory_undo); nothing is deleted. A session may merge exactly the rows it may read: global rows are mergeable from anywhere, but a row belonging to another repository is refused in either seat. Refuses before writing when the reason or the survivor id is missing, the survivor id names no row in the store, the loser is already superseded or is the survivor itself, or either seat names a foreign repository's row. Later lock or I/O failures can leave partial changes; the reply names the completed retirement and failure.",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        if (!args.loser || !args.survivor || !args.reason) {
          return { content: "merge_review blocked: loser, survivor, and reason are all required (fail-closed)." };
        }
        if (args.loser === args.survivor) {
          // (Same-row input would mark and then revive the same row: a
          // silent no-op that reports full success.)
          return { content: "merge_review blocked: loser and survivor are the same row — nothing to resolve. No evidence written." };
        }
        // A row id is a pointer, not authority (#131): resolving and
        // authorizing BOTH seats happens against the caller's Reader —
        // captured at entry, never re-read after an await (#127) — and the
        // whole resolve/check/mutate runs under the same update-order lock
        // memory_update serializes on (#125), so the authorization is
        // revalidated under the mutation lock instead of against a snapshot
        // a concurrent update could have replaced. Acquisition order is
        // always update-order then store-file locks, never the reverse, so
        // this cannot deadlock against a plain writer; on timeout it fails
        // closed with nothing written.
        const reader = readerFromSid(sid);
        // A batch may publish the loser then refuse a later file. The sink
        // records that publish before the overall promise settles (#197).
        const mergeDurable: string[] = [];
        try {
          return await withStoreLock(
            join(memoryRoot(), "update-order"),
            async () => {
              const all = await loadAll();
              const survivorRow = all.find((m) => m.ts === args.survivor);
              // Probed: marking with a survivor id that names no row retired
              // the loser toward a pointer to nothing (the scope ended with
              // zero active rows) while the response declared it canonical.
              // Validate BEFORE touching the loser — a resolution must never
              // retire real data for a phantom.
              if (!survivorRow) {
                return { content: `merge_review blocked: survivor ${args.survivor} does not exist in the store — nothing to resolve. No evidence written.` };
              }
              const loserRow = all.find((m) => m.ts === args.loser);
              // Visibility is the authorization contract (#131): a session
              // may merge exactly the rows it may read. Global and legacy
              // unstamped rows are visible everywhere and therefore
              // mergeable from anywhere — stated here, not granted
              // implicitly by store-wide reach. A foreign row in EITHER
              // seat — including an attempt to revive another repository's
              // superseded survivor — is refused before any mutation.
              if (loserRow && !isVisibleTo(loserRow, reader)) {
                return { content: "merge_review blocked: the loser belongs to another repository — this session may not retire it. Nothing was done. No evidence written." };
              }
              if (!isVisibleTo(survivorRow, reader)) {
                return { content: "merge_review blocked: the survivor belongs to another repository — this session may not promote or revive it. Nothing was done. No evidence written." };
              }
              const ok = await markSuperseded(args.loser, {
                superseded_by: args.survivor,
                reason: args.reason,
                symbol: args.loser,
                from: args.loser,
                to: args.survivor,
              }, mergeDurable);
              if (!ok) {
                return { content: "merge_review: loser not found or already superseded — nothing to resolve. No evidence written." };
              }
              // The survivor may itself have been superseded earlier (e.g. by
              // a row this very call just made the loser). Declaring it
              // canonical has to make it recallable, so clear its own marker.
              const revived = await clearSuperseded(args.survivor);
              // The response has always claimed "Evidence recorded" — now it
              // is true, and it names the session the merge ran FOR (#121's
              // residue on this line). The host tool_result hook covers
              // grep/read/edit/shell only, so a merge used to leave zero
              // trace: which reviewer decision, on which reason, reviving
              // what — unauditable.
              await record(
                "merge_resolved",
                {
                  loser: args.loser,
                  survivor: args.survivor,
                  revived,
                  reason: args.reason,
                },
                true,
                sid,
              );
              return {
                content:
                  `Resolved merge: ${args.survivor} is canonical; ${args.loser} superseded (recoverable via memory_undo). ` +
                  (revived ? `Survivor's own supersession cleared, it is active again. ` : "") +
                  `Evidence recorded for reason='${args.reason}'.`,
              };
            },
            {
              onTimeout: "fail",
              onEvent: (event, waitedMs) => {
                void record("store_lock", { event, waited_ms: waitedMs, op: "merge" });
              },
            },
          );
        } catch (err) {
          // Before mutation this is the fail-closed lock contract: nothing
          // written. Once a file published, the loser IS retired —
          // the honest report names the completed mutation and the failed
          // follow-up (evidence/revive), not a blanket "nothing was done".
          const why = err instanceof Error ? err.message : String(err);
          if (mergeDurable.length === 0) {
            return {
              content: `merge_review blocked: ${why} — nothing was done. Retry.`,
            };
          }
          return {
            content:
              `merge_review PARTIAL: ${args.loser} IS retired on disk (superseded_by ${args.survivor}; ` +
              `recoverable via memory_undo) but the remaining operation failed: ${why}. ` +
              `The evidence line may be missing; re-running reports the loser already superseded.`,
          };
        }
      },
    }));
};
