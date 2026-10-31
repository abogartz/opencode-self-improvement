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
import { record, chainId, contentHash } from "../evidence.ts";
import { removeTombstone, tombstone } from "../tombstones.ts";
import { redactSecrets } from "../secrets.ts";
import { appendLog, fileIdentity, formatLine, parseLine, readLines, writeAtomic } from "../logfmt.ts";
import { withStoreLock, LOCK_WRITE } from "../lock.ts";
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
//
// ORIGIN PRESERVATION (#129): the replacement carries the target's repo stamp
// verbatim. The viewer is an ADMIN entry point with no repository scope of
// its own; letting appendMemory resolve the stamp from that null scope used
// to leave every edited row unstamped — i.e. silently GLOBAL, recallable and
// injectable in every other project. An edit must never widen visibility: a
// row from repo A stays invisible everywhere except A (and global rows, as
// before) after an edit. Making a row global is a deliberate action (the
// `global` flag on memory_remember), never a side effect of who clicked edit.
// An unstamped target (legacy row, or one explicitly stored global) has no
// origin to carry: the replacement is stamped explicitly "global" — same
// visibility as the absent stamp, and now honest about it on the line itself.
export async function editMemory(input: EditInput): Promise<MutationResult> {
  requireReason(input.reason);
  const chain = chainId();
  const target = await findMemory(input.ts);

  const snapshot = await snapshotFiles([target.file]);
  const newTs = await appendMemory({
    type: input.type || target.type,
    scope: input.scope || target.scope,
    content: input.content,
    // Omitted metadata survives the edit (#129): the usual UI sends
    // type/scope/content/reason, and dropping the old issue/tags/kw erased
    // import/auto-capture provenance and retrieval aliases from a row whose
    // prose only got a typo fix.
    issue: input.issue ?? target.issue,
    tags: input.tags ?? target.tags,
    kw: target.kw,
    status: target.status,
    repo: target.repo ?? "global",
    repoPath: target.repo ? target.repoPath : undefined,
  });
  const retired: string[] = [];
  try {
    await markSuperseded(input.ts, {
      superseded_by: newTs,
      reason: "human_edit",
    }, retired);
  } catch (err) {
    throw new Error(`viewer edit PARTIAL: replacement ${newTs} IS on disk; original ${input.ts} ${retired.includes(input.ts) ? "IS retired" : "was NOT retired by this edit"}. Stopped: ${String(err)}. Inspect the rows or use memory_undo before retrying.`);
  }
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

  // Snapshot, filter and republish happen as one locked step, so a row another
  // session appended while we read cannot be filtered out with the target.
  let snapshot: string[] = [];
  await withStoreLock(
    target.file,
    async () => {
      const since = await fileIdentity(target.file);
      const lines = await readLines(target.file);
      const kept = lines.filter((l) => {
        const f = parseLine(l);
        return !(f && f.ts === input.ts);
      });
      if (kept.length === lines.length) throw new Error(`memory line not found: ${input.ts}`);
      snapshot = await snapshotFiles([target.file]);
      await writeAtomic(target.file, kept.join("\n") + (kept.length ? "\n" : ""), since);
    },
    LOCK_WRITE,
  );

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
      // Origin survives the audit record (#129): the viewer's restore-entry
      // path reads these lines, and a restore of a repo-private row must be
      // able to re-stamp what was deleted. A line with no stamp is the
      // legacy/unstamped case — restore leaves it global, as documented.
      repo: mem.repo,
      repoPath: mem.repoPath,
      // Same write-boundary rule as evidence (#128): an audit reason is
      // human prose and must not persist a recognized credential.
      reason: redactSecrets(reason),
    }),
  );
}

// Blocking is a human rejection, so it tombstones the VALUE as well as hiding
// the row (#35): without that, re-ingesting the source stores the same content
// again under a fresh `ts` and the block silently stops protecting anything.
// Order matters — the block is what the operator asked for and lands first; a
// failure to tombstone leaves the row hidden (no data loss) rather than the
// reverse (row visible, rejection half-applied).
export async function blockMemory(input: { ts: string; reason: string }): Promise<string> {
  requireReason(input.reason);
  const mem = await findMemory(input.ts);
  await addBlock(input.ts, input.reason);
  await tombstone(mem.content, {
    reason: redactSecrets(input.reason),
    source: "block",
    scope: mem.scope,
    type: mem.type,
  });
  return input.ts;
}

// Un-blocking withdraws the rejection, so it lifts the tombstone too — leaving
// it would mean the value stays refused while the row it was refused on is
// back in view. The tombstone is keyed on the value, so this withdraws the
// rejection of that content wherever else a copy of it was blocked; that is the
// same decision the tombstone made when it was written.
export async function unblockMemory(ts: string): Promise<boolean> {
  const removed = await removeBlock(ts);
  const mem = (await loadAll()).find((x) => x.ts === ts);
  if (mem) await removeTombstone(contentHash(mem.content));
  return removed;
}

// The explicit un-tombstone escape hatch (#35): lifts a rejection recorded by
// `forget`, which has no row left to un-block. Human-only — this is reachable
// from the viewer and deliberately from NO plugin tool, so a session whose
// write was refused cannot clear its own refusal and retry in the same turn.
export async function unrejectMemory(ch: string): Promise<boolean> {
  return removeTombstone(ch);
}

export { addBlock, removeBlock };
