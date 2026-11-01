// The memory_consolidate tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { proposeConsolidations, renderProposals } from "../consolidate.ts";
import { record } from "../evidence.ts";
import { readLedger, readReads } from "../hits.ts";
import { isInjectable, isVisibleTo, loadAll, readerFromSid } from "../memory.ts";
import { ConsolidateArgs, validated } from "../schema.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, direct } = deps;
    editor.add(validated(ConsolidateArgs, {
      name: "memory_consolidate",
      description:
        "Propose consolidations of near-duplicate settled rows — read-only, nothing is written. Clusters same-scope same-type rows by jaccard, picks the most recently used member as canonical (#42's rule: the row retrieval keeps landing on), and proposes it ONLY when replaying the cluster's own logged reads proves the merged row catches at least as many reads as the best single member did. A cluster with no recorded reads is reported as unmeasured, never merged on resemblance. Resolve a proposal with memory_merge_review; absorbed rows stay recoverable. The merge is deterministic — the canonical row is the survivor's prose plus the absorbed rows' aliases — because this plugin ships no model and a rewritten row cannot be diffed or audited.",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        const reader = readerFromSid(sid);
        const all = (await loadAll()).filter(isInjectable).filter((m) => isVisibleTo(m, reader));
        const rows = args.scope ? all.filter((m) => m.scope === args.scope) : all;
        const ledger = await readLedger();
        const use = ledger.byRow;
        const reads = await readReads();
        const report = proposeConsolidations(rows, use, reads, {
          ...(args.jaccard !== undefined ? { jaccard: args.jaccard } : {}),
        });
        const shown = report.plans.slice(0, args.limit ?? 10);
        const out = renderProposals({ ...report, plans: shown });
        await record(
          "consolidate_propose",
          { clusters: shown.length, rows: report.rowsBefore, would_drop: report.rowsBefore - report.rowsAfter },
          false,
        );
        return { content: out };
      },
    }));
};
