// render — split from src/consolidate.ts (#168 domain restructure). Declaration bodies are unchanged.

import { type ProposalReport } from "./propose.ts";

/** Human-readable proposal list. Ends with the exact command to resolve one. */
export function renderProposals(report: ProposalReport): string {
  const out: string[] = ["CONSOLIDATION PROPOSALS — nothing was written", ""];
  if (!report.plans.length) {
    out.push("  none — no cluster proved it could hold its reads.");
    return out.join("\n");
  }
  for (const p of report.plans) {
    out.push(
      `${p.id}  ${p.type}/${p.scope}  ${p.losers.length + 1} rows → 1`,
      `  keep   ${p.survivor.ts}`,
      `    ${p.survivor.content.slice(0, 160)}`,
      ...p.losers.map((l) => `  absorb ${l.ts}  ${l.content.slice(0, 120)}`),
      `  reads  ${p.reads.length} logged · best member alone ${p.bestMemberBefore} · merged ${p.readsAfter}`,
      `  budget ${p.bytesBefore}c → ${p.bytesAfter}c for this cluster`,
      `  resolve: memory_merge_review(loser="${p.losers[0]!.ts}", survivor="${p.survivor.ts}", reason="consolidate ${p.id}")`,
      "",
    );
  }
  out.push(
    `STORE  ${report.rowsBefore} rows → ${report.rowsAfter} if every proposal is resolved · ` +
      `injected ${report.injectedBefore}c → ${report.injectedAfter}c`,
  );
  out.push("Resolving is supersede-not-delete: absorbed rows stay recoverable via memory_undo.");
  return out.join("\n");
}
