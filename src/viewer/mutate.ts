// Non-destructive viewer mutations (the human-approved branch of the write gate).
// An EDIT snapshots the pre-mutation file, marks the old entry superseded, then
// appends the edited entry exactly once. A DELETE snapshots the pre-mutation
// file and removes the entry plus an audited reason. Nothing is ever destroyed:
// every pre-mutation state is retained (git-style, one snapshot per mutation)
// and the old entry stays visible as superseded. Block is the poison
// intervention: keep the entry on disk but hide it from every read path.
// All mutations require a reason and write audit + evidence lines.
import { deletionsFile } from "../config.ts";
import { addBlock, removeBlock } from "../blocklist.ts";
import { record, chainId } from "../evidence.ts";
import { appendLog, formatLine, parseLine, readLines } from "../logfmt.ts";
import {
  appendMemory,
  loadAll,
  markSuperseded,
  snapshotFiles,
  type Memory,
} from "../memory.ts";

export interface EditInput {
  ts: string;
  type: string;
  scope: string;
  content: string;
  issue?: string;
  tags?: string[];
  reason: string;
}

export interface DeleteInput {
  ts: string;
  reason: string;
}

export interface MutationResult {
  action: "edited" | "deleted";
  ts: string;
  superseded_by?: string;
  snapshot: string;
  audit: string;
  chain: string;
}

function requireReason(reason: string): void {
  if (!reason.trim()) throw new Error("reason is required");
}

async function findMemory(ts: string): Promise<Memory> {
  const m = (await loadAll()).find((x) => x.ts === ts);
  if (!m) throw new Error(`memory not found: ${ts}`);
  return m;
}

// Non-destructive edit: snapshot the pre-state, supersede the old entry, then
// append the edited replacement (added ONLY because the edit requires it).
export async function editMemory(input: EditInput): Promise<MutationResult> {
  requireReason(input.reason);
  const chain = chainId();
  const target = await findMemory(input.ts);

  const snapshot = await snapshotFiles([target.file]);
  const newTs = await appendMemory({
    type: input.type || target.type,
    scope: input.scope || target.scope,
    content: input.content,
    issue: input.issue,
    tags: input.tags,
    status: target.status,
  });
  await markSuperseded(input.ts, {
    superseded_by: newTs,
    reason: "human_edit",
  });
  await audit("edited", target, input.ts, newTs, input.reason);
  await record("viewer_edit", {
    chain,
    ts: newTs,
    original: input.ts,
    supersedes: input.ts,
    reason: input.reason,
    snapshot: snapshot[0] ?? "-",
    op: "write",
  });

  return {
    action: "edited",
    ts: input.ts,
    superseded_by: newTs,
    snapshot: snapshot[0] ?? "-",
    audit: deletionsFile(),
    chain,
  };
}

// Non-destructive delete: snapshot the pre-state, remove the entry, audit.
export async function deleteMemory(input: DeleteInput): Promise<MutationResult> {
  requireReason(input.reason);
  const chain = chainId();
  const target = await findMemory(input.ts);

  const snapshot = await snapshotFiles([target.file]);
  const lines = await readLines(target.file);
  const kept = lines.filter((l) => {
    const f = parseLine(l);
    return !(f && f.ts === input.ts);
  });
  if (kept.length === lines.length) throw new Error(`memory line not found: ${input.ts}`);
  await Bun.write(target.file, kept.join("\n") + (kept.length ? "\n" : ""));

  await audit("deleted", target, input.ts, undefined, input.reason);
  await record("prune", {
    chain,
    mem: input.ts,
    reason: input.reason,
    snapshot: snapshot[0] ?? "-",
    audit: deletionsFile(),
    tool: "memory_viewer",
  });

  return {
    action: "deleted",
    ts: input.ts,
    snapshot: snapshot[0] ?? "-",
    audit: deletionsFile(),
    chain,
  };
}

async function audit(
  action: "edited" | "deleted",
  mem: Memory,
  originalTs: string,
  newTs: string | undefined,
  reason: string,
): Promise<void> {
  await appendLog(
    deletionsFile(),
    formatLine({
      ts: new Date().toISOString(),
      action,
      original_ts: originalTs,
      ...(newTs ? { superseded_by: newTs } : {}),
      type: mem.type,
      scope: mem.scope,
      content: mem.content,
      reason,
    }),
  );
}

export { addBlock, removeBlock };