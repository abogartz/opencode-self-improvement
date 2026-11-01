// The memory_remember tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { auditCaveat, runWriteGate } from "../gates.ts";
import type { WriteCandidate } from "../gates.ts";
import { RememberArgs, validated } from "../schema.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, bindSessionIdentity, ownerlessWriter, refuseOwnerlessWrite, gateContext, direct } = deps;
    editor.add(validated(RememberArgs, {
      name: "memory_remember",
      description:
        "Store a memory after the 4-gate write pipeline validates it (canonical graph, stale refs, dupes). Blocked writes record evidence instead of persisting. Add `kw` — 3-5 aliases, synonyms, verb forms or the literal command a FUTURE session would search with — to make a row findable when the wording differs; keywords are indexed, never injected.",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        const candidate: WriteCandidate = {
          type: args.type,
          scope: args.scope,
          content: args.content,
          issue: args.issue,
          tags: args.tags,
          kw: args.kw,
          status: args.status,
          repo: args.global ? "global" : undefined,
        };
        await bindSessionIdentity(sid);
        // An explicit global write needs no repository owner; anything else
        // does (#152).
        if (!args.global) {
          const ownerless = ownerlessWriter(sid);
          if (ownerless) return await refuseOwnerlessWrite(ownerless, "remember");
        }
        const outcome = await runWriteGate(candidate, gateContext(sid));
        // A durable row whose audit line fell is NOT a clean success
        // (#155 review): the reply says what is missing where it is
        // missing, and the row itself stands.
        if (outcome.action === "promoted")
          return { content: `Remembered: ${args.type} in ${args.scope}${auditCaveat(outcome)}` };
        if (outcome.action === "collapsed") return { content: `Duplicate ignored: ${args.type}/${args.scope}` };
        return {
          content: `Write blocked at GATE (${outcome.reason}). ${
            outcome.hint ?? "Evidence recorded; inspect with memory_evidence."
          }`,
        };
      },
    }));
};
