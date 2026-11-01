// deletions — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { deletionsFile } from "../../core/config/paths.ts";
import { formatLine } from "../../core/logfmt/format.ts"
import { appendLog } from "../../core/logfmt/publish.ts";
import { redactSecrets } from "../secrets.ts";
import { type Memory } from "../model/memory.ts";

export interface DeletedMemory {
  memory: Memory;
  reason: string;
}

export async function logDeletion(memory: Memory, reason: string): Promise<void> {
  await appendLog(
    deletionsFile(),
    formatLine({
      ts: new Date().toISOString(),
      action: "deleted",
      original_ts: memory.ts,
      type: memory.type,
      scope: memory.scope,
      content: memory.content,
      // Origin survives the delete/restore round trip (#129): a restore-entry
      // made from this line re-stamps what the row carried. A row with no
      // stamp writes no stamp here — the legacy global path, unchanged.
      repo: memory.repo,
      repoPath: memory.repoPath,
      reason: redactSecrets(reason),
    }),
  );
}
