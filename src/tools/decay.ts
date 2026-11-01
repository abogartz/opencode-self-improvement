// The memory_decay tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { record } from "../evidence/record.ts";
import { snapshotFiles } from "../store/files/snapshots.ts"
import { markManySuperseded } from "../store/files/supersede.ts";
import { findStaleOpen } from "../portable/decay.ts";
import { flattenMemoryText } from "../store/sanitize.ts";
import { DecayArgs, validated } from "./schema.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, direct } = deps;
    editor.add(validated(DecayArgs, {
      name: "memory_decay",
      description:
        "Retire stale open threads (status=open older than olderThanDays) by superseding them — never deleting; rows stay recoverable via memory_undo. DRY RUN BY DEFAULT: without an explicit dryRun=false this only LISTS what would retire and mutates nothing (fail-closed). A real run snapshots every affected file before the first mutation.",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        const days = Number(args.olderThanDays) > 0 ? Number(args.olderThanDays) : 14;
        const dryRun = args.dryRun !== false; // only an explicit false mutates
        const stale = await findStaleOpen(days, sid);
        if (!stale.length) {
          return { content: `No active open threads older than ${days} days.` };
        }
        const listing = stale
          .map(
            (m) =>
              `  ${flattenMemoryText(m.ts)} ${flattenMemoryText(m.type)}/${flattenMemoryText(m.scope)}: ${flattenMemoryText(m.content).slice(0, 100)}`,
          )
          .join("\n");
        if (dryRun) {
          await record(
            "decay_dry_run",
            { days, stale: stale.length, mem: stale.map((m) => m.ts).join(",") },
            false,
          );
          return {
            content:
              `Dry run: ${stale.length} open thread(s) older than ${days} days:\n${listing}\n` +
              "Re-run with dryRun=false to supersede them (snapshot first; recoverable via memory_undo).",
          };
        }
        // Snapshot-before-mutate: the SAME helper prune() uses in memory.ts,
        // one whole-file copy per affected file, taken before the first
        // mutation. The batch pass snapshots again per file it touches; this
        // pass guarantees a pre-decay copy exists even if a later file fails.
        const snapshot = await snapshotFiles([...new Set(stale.map((m) => m.file))]);
        // One lock/read/snapshot/publish per file for the whole decay run (#61):
        // N retired rows are one undo point, not N. Idempotent (a no-op on rows
        // already superseded, out-of-band ones skipped under the lock).
        const durable: string[] = [];
        let retired: number;
        try {
          retired = await markManySuperseded(
            stale.map((m) => ({ ts: m.ts, fields: { superseded_by: "decay", reason: "decay" } })), durable,
          );
        } catch (err) {
          if (durable.length === 0) throw err;
          let why = err instanceof Error ? err.message : String(err);
          await record("decay_applied", { days, retired: durable.length, mem: durable.join(","), snapshot: snapshot.join(","), partial: true, error: why }, false).catch((audit) => { why += `; audit failed: ${String(audit)}`; });
          return { content: `memory_decay PARTIAL: retired row(s) ${durable.join(", ")}; stopped: ${why}. Recover with memory_undo; inspect memory_evidence before retrying.` };
        }
        await record(
          "decay_applied",
          {
            days,
            retired,
            mem: durable.join(",") || "-",
            snapshot: snapshot.join(",") || "-",
          },
          false,
        );
        return {
          content:
            `Decayed ${retired} open thread(s) older than ${days} days ` +
            `(superseded, not deleted; snapshot: ${snapshot[0] ?? "-"}). ` +
            "Recover with memory_undo.",
        };
      },
    }));
};
