// The memory_forget tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { pruneMemory } from "../prune.ts";
import { ForgetArgs, validated } from "../schema.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, direct } = deps;
    editor.add(validated(ForgetArgs, {
      name: "memory_forget",
      description:
        "Delete memories by scope and type. Snapshots first, logs the reason for audit, never touches a repo.",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        const res = await pruneMemory(args.scope, args.type, args.reason, sid);
        if (res.error) return { content: `memory_forget PARTIAL: deleted row(s) ${res.deleted.map((d) => d.memory.ts).join(", ")}; stopped: ${res.error}. Rejection tombstones or audit lines may be incomplete. Inspect memory_evidence / memory_undo before retrying.` };
        if (!res.deleted.length) return { content: `No memories found for ${args.type} in ${args.scope}` };
        return { content: `Deleted ${res.deleted.length} ${args.type} memory(s) from ${args.scope}. Audit: ${res.audit}` };
      },
    }));
};
