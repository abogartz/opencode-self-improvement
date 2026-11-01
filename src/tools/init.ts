// The memory_init tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { formatInit } from "../init/format.ts"
import { runInit } from "../init/run.ts";
import { InitArgs, validated } from "./schema.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, bindSessionIdentity, ownerlessWriter, refuseOwnerlessWrite, gateContext, direct } = deps;
    editor.add(validated(InitArgs, {
      name: "memory_init",
      description:
        "Initialize repository memory and knowledge graph. Ensures the codebase-memory graph for this repo is indexed (one-shot `cli` spawn; no session MCP needed) and re-derives build/lint/test/typecheck command memories through the write gate, then stores an init stamp keyed on git HEAD. Idempotent: a no-op when the stamp matches HEAD, unless force=true (refresh after a refactor).",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        await bindSessionIdentity(sid);
        const ownerless = ownerlessWriter(sid);
        if (ownerless) return await refuseOwnerlessWrite(ownerless, "init");
        const summary = await runInit({
          liveRoot: gateContext(sid).liveRoot,
          force: args.force,
          mode: args.mode,
          sessionID: sid,
        });
        return { content: formatInit(summary) };
      },
    }));
};
