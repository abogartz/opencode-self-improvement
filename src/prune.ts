// Principle 3: a human can prune a bad memory. Deletion is auditable (reason),
// reversible (snapshot) and never touches a repo. The `prune` evidence line is
// emitted before/around the mutation so S5 can assert the reason and snapshot.
import { deletionsFile } from "./config.ts";
import { prune, type PruneResult } from "./memory.ts";
import { record } from "./evidence.ts";

export async function pruneMemory(
  scope: string,
  type: string,
  reason: string,
): Promise<PruneResult & { audit: string }> {
  const res = await prune(scope, type, reason);
  const memTs = res.deleted.map((d) => d.memory.ts).join(",") || "-";
  await record("prune", {
    mem: memTs,
    reason,
    snapshot: res.snapshot[0] ?? "-",
    audit: deletionsFile(),
    tool: "memory_forget",
  });
  return { ...res, audit: deletionsFile() };
}
