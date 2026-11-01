// The memory_export tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { exportMemories } from "../portable/export.ts";
import { ExportArgs, validated } from "./schema.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, direct } = deps;
    editor.add(validated(ExportArgs, {
      name: "memory_export",
      description:
        "Export active memories as a JSONL file for backup or transfer to another machine — scoped to what this session can read: its own repository plus global rows (full-store breadth belongs to a session-less call made outside the plugin, the library route; the viewer has no export route). The first line is a metadata header ({_export,version,exportedAt,count}); each later line is one JSON object {ts,type,scope,content,status,tags,issue}. The header is what lets memory_import keep repo-scoped status:\"open\" frontier rows — a hand-written file without it imports such rows as settled, as does an imported open row claiming repo:\"global\". Defaults to a unique <memory-root>/exports/<timestamp>-<unique>.jsonl (each default export gets its own file; two exports in the same second never share a path); `file` must name a path inside <memory-root>/exports (a relative path resolves against it), `scope` exports one scope. Superseded rows are not exported (history stays in the store).",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        try {
          const { sid } = toolIds(context);
          const res = await exportMemories({ scope: args.scope, file: args.file, sessionID: sid });
          return { content: `Exported ${res.count} memories -> ${res.path}` };
        } catch (err) {
          return {
            content: `memory_export failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }));
};
