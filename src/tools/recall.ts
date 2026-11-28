// The memory_recall tool, extracted from index.ts. Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { record } from "../telemetry/record.ts";
import { formatMemory } from "../inject/format.ts";
import {
  admitsRow,
  exactAliasMatches,
  gateEnabled,
  queryConcepts,
  recallHaystack,
} from "../recall/gate.ts";
import { loadAll } from "../store/files/load.ts";
import { isInjectable } from "../store/model/predicates.ts";
import { isVisibleTo, readerFromSid } from "../store/model/visibility.ts";
import type { Memory } from "../store/model/memory.ts";
import { RecallArgs, validated } from "./schema.ts";
import { firstFrontierTap, markFrontierTap } from "../capture/triggers.ts";
import { dedupeThreshold, dedupeWindowGrouped } from "../recall/dedupe.ts";
import { ambiguousLine } from "../recall/ambiguous.ts";

function scoreMemory(m: Memory, q: string): number {
  // Same indexed fields as the injection scorer: a row recalled by one of
  // its keywords is the same row recalled by the prose that keyword stands for.
  const hay = recallHaystack(m);
  let score = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (hay.includes(w)) score++;
    if (m.scope.toLowerCase() === w) score += 2;
    if (m.type.toLowerCase() === w) score += 2;
  }
  return score;
}

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, noteHits } = deps;
  editor.add(
    validated(RecallArgs, {
      name: "memory_recall",
      description:
        "Look up durable project knowledge — build/test/lint commands, decisions, patterns, preferences, blockers — BEFORE searching the repo or reading files. Use for 'how do I run X', conventions, and past decisions. By scope, type, or free-text query; with no filters it returns the most recent memories. Returns at most 5 rows by default, best match first — pass `limit` when you genuinely need a wider sweep.",
      async execute(args, context): Promise<{ content: string }> {
        const { sid, call } = toolIds(context);
        const reader = readerFromSid(sid);
        let results = (await loadAll())
          .filter(isInjectable)
          .filter((m) => isVisibleTo(m, reader));
        if (!results.length) return { content: "No memories found" };
        const total = results.length;
        if (args.scope)
          results = results.filter((m) => m.scope.includes(args.scope!));
        if (args.type) results = results.filter((m) => m.type === args.type);
        if (args.query) {
          const gate = gateEnabled();
          const concepts = gate ? queryConcepts(args.query) : [];
          const aliases = exactAliasMatches(args.query, concepts, results);
          results = results
            .map((m) => ({
              m,
              score: Math.max(
                scoreMemory(m, args.query!),
                aliases.has(m) ? 1 : 0,
              ),
            }))
            .filter(
              (x) =>
                x.score > 0 &&
                (!gate || aliases.has(x.m) || admitsRow(x.m, concepts)),
            )
            .sort((a, b) => b.score - a.score)
            .map((x) => x.m);
        }
        // the default window was 20. A live audit joined 1,090 recall
        // events to their session transcripts: rank-1 rows go on to be
        // referenced at 3.4x the rate of a random store row, ranks 11-20 at
        // 1.16x — noise. Returning 17.7 rows per call meant most of the window
        // was paid for in context and never read. 5 is the last rank where a
        // useful row survives the cut; a caller that wants more still asks.
        // Non-positive or fractional limits are coerced, never trusted: a
        // negative slice(0, n) / slice(-n) silently returns MORE rows, not fewer.
        const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 5;
        // dedup lane (RESULTS §17): default on at 0.8 — near-duplicate
        // copies are skipped so the window fills with distinct rows instead of
        // repeats of the top hit. OPENCODE_MEMORY_DEDUP=0 restores the plain
        // slice. A clash where one row is wholly contained in the other names a
        // second thing rather than a corrected one, so both are kept and an
        // AMBIGUOUS line says so; OPENCODE_MEMORY_AMBIGUOUS=0 collapses those too.
        const dedupeAt = dedupeThreshold();
        const grouped = args.query
          ? dedupeWindowGrouped(results, limit, dedupeAt)
          : { rows: results.slice(-limit), groups: [] };
        const limited = grouped.rows;
        if (!limited.length) return { content: "No matching memories" };
        const openIn = limited.filter((m) => m.status === "open").length;
        if (openIn > 0) {
          markFrontierTap(sid, call);
          await record(
            "frontier_tapped",
            {
              n_open: openIn,
              in_results: limited.length,
              turn: firstFrontierTap(sid)?.turn,
            },
            true,
            sid,
          );
        }
        if (args.query) await noteHits("recall", sid, limited, args.query);
        const lines = limited.map(formatMemory);
        // A kept group is named after the rows it describes, numbered to match
        // the list above. Resolved by object identity rather than by position
        // arithmetic: the group carries the same objects the window holds.
        for (const family of grouped.groups) {
          // Resolved by object identity rather than position arithmetic: the
          // family carries the same objects the window holds.
          const at = family.map((m) => limited.indexOf(m));
          if (at.every((i) => i >= 0))
            lines.push(
              ambiguousLine(
                family,
                at.map((i) => i + 1),
              ),
            );
        }
        return {
          content: `Found ${results.length} (${total} total)\n\n${lines.join("\n")}`,
        };
      },
    }),
  );
};
