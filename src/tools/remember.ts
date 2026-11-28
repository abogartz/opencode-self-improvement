// The memory_remember tool. Closure access arrives through ToolDeps; the
// volatile session lane is the injection controller's map, handed to the gate
// only for writes the author marked session-scoped.
import type { ToolRegister } from "./deps.ts";
import { auditCaveat, runWriteGate } from "../gate/gate.ts";
import type { WriteCandidate } from "../gate/gate.ts";
import { RememberArgs, validated } from "./schema.ts";
import { nonCaptureTags } from "../core/guidance.ts";

export const register: ToolRegister = (editor, deps) => {
  const {
    toolIds,
    bindSessionIdentity,
    ownerlessWriter,
    refuseOwnerlessWrite,
    gateContext,
    sessions,
  } = deps;
  editor.add(
    validated(RememberArgs, {
      name: "memory_remember",
      description:
        "Store a memory after the 4-gate write pipeline validates it (canonical graph, stale refs, dupes). Blocked writes record evidence instead of persisting. Add `kw` — 3-5 aliases, synonyms, verb forms or the literal command a FUTURE session would search with — to make a row findable when the wording differs; keywords are indexed, never injected.",
      async execute(args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        const candidate: WriteCandidate = {
          type: args.type,
          scope: args.scope,
          content: args.content,
          issue: args.issue,
          tags: nonCaptureTags(args.tags),
          kw: args.kw,
          status: args.status,
          repo: args.global ? "global" : undefined,
          session: args.session,
        };
        await bindSessionIdentity(sid);
        // An explicit global write needs no repository owner; anything else
        // does.
        if (!args.global) {
          const ownerless = ownerlessWriter(sid);
          if (ownerless)
            return await refuseOwnerlessWrite(ownerless, "remember");
        }
        const outcome = await runWriteGate(candidate, {
          ...gateContext(sid),
          // Only this entry point holds the volatile map; a session-flagged
          // write from any other gate caller fails closed without it.
          sessionFacts: sessions,
        });
        // A session-scoped fact is NOT a durable row: the reply must say so
        // plainly, or the model believes it stored something that survives.
        // The evidence line is the only durable half.
        if (outcome.action === "session_scoped")
          return {
            content:
              `Kept for this session only: ${args.type}/${args.scope}. ` +
              `No durable memory row was created — this fact is injected ` +
              `into this session's context only, until compaction or a ` +
              `server restart. The repository's evidence log retains its ` +
              `text and outlives the process: any session in this ` +
              `repository can read it with memory_evidence ` +
              `ev=session_scoped.`,
          };
        // A durable row whose audit line fell is NOT a clean success
        // the reply says what is missing where it is
        // missing, and the row itself stands.
        if (outcome.action === "promoted")
          return {
            content: `Remembered: ${args.type} in ${args.scope}${auditCaveat(outcome)}`,
          };
        if (outcome.action === "collapsed")
          return { content: `Duplicate ignored: ${args.type}/${args.scope}` };
        return {
          content: `Write blocked at GATE (${outcome.reason}). ${
            // F1: the catch-all must name the filter a reader needs.
            // `ev` matches the EVENT type (`write_blocked`), never the block
            // reason — a session that guesses the reason gets "No evidence"
            // while the row is in the log. Keep the `ev=write_blocked`
            // literal in any future hint change.
            outcome.hint ??
            "Evidence recorded; inspect with memory_evidence ev=write_blocked."
          }`,
        };
      },
    }),
  );
};
