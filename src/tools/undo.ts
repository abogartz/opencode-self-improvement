// The memory_undo tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { memoryRoot } from "../core/config/paths.ts";
import { readerFromSid } from "../store/model/visibility.ts";
import { UndoArgs, validated } from "./schema.ts";
import { listSnapshots, restoreSnapshot } from "../store/undo.ts";
import { basename } from "node:path";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, direct } = deps;
    editor.add(validated(UndoArgs, {
      name: "memory_undo",
      description:
        "List memory snapshots, or restore one (rollback). Only snapshots inside this store's snapshots directory are accepted: pass a bare name from the list or its full path. Non-standard files in snapshots/ are not listed or restorable. SAFE BY DEFAULT: restore refuses if the current file has rows added or edited since the snapshot, and audited human/tool deletions stay deleted. Re-run with merge=true to restore AND keep divergent rows, or force=true for an explicit exact rollback. Blocklisted rows remain inactive in every mode. Rows belonging to other repositories are never restored, rewound, or dropped in any mode — their lines survive verbatim, though a restore may place them later in the shared file. Global rows are visible to every repository, so they are in every repository's rollback scope.",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        if (args.snapshot) {
          const mode = args.force ? "force" : args.merge ? "merge" : "check";
          // Day files are shared across repositories (#153): the rollback
          // carries the CALLER's reader, so rows another repo owns survive
          // untouched in every mode instead of riding the snapshot wholesale.
          const { sid } = toolIds(context);
          const res = await restoreSnapshot(args.snapshot, memoryRoot(), mode, readerFromSid(sid));
          if (!res.restored) {
            const parts = [...res.concurrentAdded, ...res.concurrentChanged];
            return {
              content:
                `Undo refused: ${res.concurrentAdded.length} row(s) added and ` +
                `${res.concurrentChanged.length} changed since this snapshot — the shared file ` +
                `moved after it. Divergent rows (ts): ${parts.join(", ")}. ` +
                `If those belong to another session, re-run with merge=true (restore the file ` +
                `AND keep them); if they are the writes you are undoing, use force=true. ` +
                (res.foreignPreserved
                  ? `${res.foreignPreserved} row(s) in this file belong to other repositories; they survive in every mode.`
                  : "Rows belonging to other repositories survive in every mode."),
            };
          }
          const kept = res.mode === "merge" && (res.concurrentAdded.length || res.concurrentChanged.length)
            ? ` Kept ${res.concurrentAdded.length} added / ${res.concurrentChanged.length} changed row(s) written after the snapshot.`
            : "";
          const safety = res.safety ? ` Pre-restore file snapshotted -> ${res.safety}.` : "";
          const omitted = res.deletedOmitted.length
            ? ` Omitted ${res.deletedOmitted.length} deliberately deleted row(s); use force=true to recover them.`
            : "";
          const foreign = res.foreignPreserved
            ? ` Left ${res.foreignPreserved} row(s) belonging to other repositories untouched.`
            : "";
          return { content: `Restored ${basename(res.target)} from ${res.mode} snapshot -> ${res.target}.${kept}${safety}${omitted}${foreign}` };
        }
        const snaps = await listSnapshots();
        if (!snaps.length) return { content: "No snapshots" };
        return { content: snaps.map((s) => `${s.name}  (${s.bytes} bytes)`).join("\n") };
      },
    }));
};
