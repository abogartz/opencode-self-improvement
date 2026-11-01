// The memory_list tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { isInjectable, isVisibleTo, loadAll, readerFromSid } from "../memory.ts";
import { flattenMemoryText } from "../sanitize.ts";
import { EmptyArgs, validated } from "../schema.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, direct } = deps;
    editor.add(validated(EmptyArgs, {
      name: "memory_list",
      description: "List memory scopes and types for discovery.",
      options: direct,
      async execute(_args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        const reader = readerFromSid(sid);
        const mems = (await loadAll()).filter(isInjectable).filter((m) => isVisibleTo(m, reader));
        if (!mems.length) return { content: "No memories found" };
        const scopes = new Map<string, number>();
        const types = new Map<string, number>();
        for (const m of mems) {
          scopes.set(m.scope, (scopes.get(m.scope) ?? 0) + 1);
          types.set(m.type, (types.get(m.type) ?? 0) + 1);
        }
        const fmt = (map: Map<string, number>) =>
          [...map.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, c]) => `  ${flattenMemoryText(k)}: ${c}`)
            .join("\n");
        return { content: `Total: ${mems.length}\n\nScopes:\n${fmt(scopes)}\n\nTypes:\n${fmt(types)}` };
      },
    }));
};
