// The memory_recall tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { record } from "../evidence.ts";
import { formatMemory } from "../inject.ts";
import { isInjectable, isVisibleTo, loadAll, readerFromSid } from "../memory.ts";
import type { Memory } from "../memory.ts";
import { RecallArgs, validated } from "../schema.ts";
import { firstFrontierTap, markFrontierTap } from "../triggers.ts";

function scoreMemory(m: Memory, q: string): number {
  // Same indexed fields as the injection scorer (#40): a row recalled by one of
  // its keywords is the same row recalled by the prose that keyword stands for.
  const kw = m.kw?.length ? ` ${m.kw.join(" ")}` : "";
  const hay = `${m.type} ${m.scope} ${m.content}${kw}`.toLowerCase();
  let score = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (hay.includes(w)) score++;
    if (m.scope.toLowerCase() === w) score += 2;
    if (m.type.toLowerCase() === w) score += 2;
  }
  return score;
}


export const register: ToolRegister = (editor, deps) => {
  const { toolIds, noteHits, direct } = deps;
    editor.add(validated(RecallArgs, {
      name: "memory_recall",
      description:
        "Look up durable project knowledge — build/test/lint commands, decisions, patterns, preferences, blockers — BEFORE searching the repo or reading files. Use for 'how do I run X', conventions, and past decisions. By scope, type, or free-text query; with no filters it returns the most recent memories.",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        const { sid, call } = toolIds(context);
        const reader = readerFromSid(sid);
        let results = (await loadAll()).filter(isInjectable).filter((m) => isVisibleTo(m, reader));
        if (!results.length) return { content: "No memories found" };
        const total = results.length;
        if (args.scope) results = results.filter((m) => m.scope.includes(args.scope!));
        if (args.type) results = results.filter((m) => m.type === args.type);
        if (args.query) {
          results = results
            .map((m) => ({ m, score: scoreMemory(m, args.query!) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((x) => x.m);
        }
        const limit = args.limit || 20;
        const limited = args.query ? results.slice(0, limit) : results.slice(-limit);
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
        return { content: `Found ${results.length} (${total} total)\n\n${limited.map(formatMemory).join("\n")}` };
      },
    }));
};
