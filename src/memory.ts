// Durable memory store engine. Reproduces the opencode-memory logfmt format
// (MIT, github.com/shuans/opencode-memory; license retained under
// vendor/opencode-memory/LICENSE) and extends it with the fields the write-gate
// needs: supersession markers, snapshots and audited deletion.
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { memoryRoot, deletionsFile, snapshotDir } from "./config.ts";
import { appendLog, ensureDir, formatLine, parseLine, readLines } from "./logfmt.ts";
import { blockedTs } from "./blocklist.ts";

export type MemoryStatus = "open" | "settled";

export interface Memory {
  ts: string;
  type: string;
  scope: string;
  content: string;
  issue?: string;
  tags?: string[];
  superseded_by?: string;
  reason?: string;
  status?: MemoryStatus;
  file: string;
  index: number;
}

const RESERVED = new Set([
  "deletions.logfmt",
  "deleted.logfmt",
  "canonical.logfmt",
  "blocklist.logfmt",
]);

function toMemory(fields: Record<string, unknown>, file: string, index: number): Memory | null {
  const ts = fields.ts;
  const type = fields.type;
  const scope = fields.scope;
  if (typeof ts !== "string" || typeof type !== "string") return null;
  if (typeof scope !== "string") return null;
  return {
    ts,
    type,
    scope,
    content: typeof fields.content === "string" ? fields.content : "",
    issue: typeof fields.issue === "string" ? fields.issue : undefined,
    tags: typeof fields.tags === "string" ? fields.tags.split(",") : undefined,
    superseded_by: typeof fields.superseded_by === "string" ? fields.superseded_by : undefined,
    reason: typeof fields.reason === "string" ? fields.reason : undefined,
    status:
      fields.status === "open" || fields.status === "settled" ? fields.status : undefined,
    file,
    index,
  };
}

export async function memoryFiles(): Promise<string[]> {
  const root = memoryRoot();
  // Bun.Glob.scan throws ENOENT on a missing root; a fresh store must read as
  // empty so the system-digest hook never throws (it runs on every request,
  // including the compaction model call).
  if (!existsSync(root)) return [];
  const glob = new Bun.Glob("*.logfmt");
  const files: string[] = [];
  for await (const f of glob.scan(root)) {
    if (!RESERVED.has(f)) files.push(join(root, f));
  }
  return files.sort();
}

export async function loadAll(): Promise<Memory[]> {
  const blocked = await blockedTs();
  const out: Memory[] = [];
  for (const file of await memoryFiles()) {
    const lines = await readLines(file);
    lines.forEach((line, index) => {
      const m = toMemory(parseLine(line) ?? {}, file, index);
      if (m && !blocked.has(m.ts)) out.push(m);
    });
  }
  return out;
}

export async function loadScope(scope: string): Promise<Memory[]> {
  return (await loadAll()).filter((m) => m.scope === scope);
}

export interface AppendMemoryInput {
  type: string;
  scope: string;
  content: string;
  issue?: string;
  tags?: string[];
  status?: MemoryStatus;
}

// Existing ts values across all memory files, used to guarantee uniqueness of
// newly appended entries (a fast seed->append within one millisecond would
// otherwise collide on the ISO timestamp).
async function existingTs(): Promise<Set<string>> {
  const set = new Set<string>();
  for (const file of await memoryFiles()) {
    for (const line of await readLines(file)) {
      const f = parseLine(line);
      if (f && typeof f.ts === "string") set.add(f.ts);
    }
  }
  return set;
}

// Append a durable memory. Only the gate's GATE-4 promotion step calls this.
export async function appendMemory(input: AppendMemoryInput): Promise<string> {
  const taken = await existingTs();
  let ts = new Date().toISOString();
  let guard = 0;
  while (taken.has(ts) && guard++ < 1000) {
    ts = new Date(new Date(ts).getTime() + 1).toISOString();
  }
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  await appendLog(
    file,
    formatLine({
      ts,
      type: input.type,
      scope: input.scope,
      content: input.content,
      issue: input.issue,
      tags: input.tags?.length ? input.tags.join(",") : undefined,
      status: input.status,
    }),
  );
  return ts;
}

export interface SupersedeFields {
  superseded_by: string;
  reason: string;
  symbol?: string;
  from?: string;
  to?: string;
  entity?: string;
}

// Mark an existing memory as superseded IN PLACE (entry retained, recoverable).
// Idempotent: a second call is a no-op, so no double `superseded_by`.
export async function markSuperseded(ts: string, fields: SupersedeFields): Promise<boolean> {
  for (const file of await memoryFiles()) {
    const lines = await readLines(file);
    const idx = lines.findIndex((l) => {
      const f = parseLine(l);
      return f && f.ts === ts;
    });
    if (idx === -1) continue;
    const parsed = parseLine(lines[idx]);
    if (parsed && typeof parsed.superseded_by === "string") return false;
    const extra = formatLine({
      superseded_by: fields.superseded_by,
      reason: fields.reason,
      symbol: fields.symbol,
      from: fields.from,
      to: fields.to,
      entity: fields.entity,
    });
    lines[idx] = `${lines[idx]} ${extra}`;
    await ensureDir(snapshotDir());
    const snap = join(snapshotDir(), `${Date.now()}-${basename(file)}`);
    await Bun.write(snap, (await Bun.file(file).text()) || "");
    await Bun.write(file, lines.join("\n") + "\n");
    return true;
  }
  return false;
}

export interface DeletedMemory {
  memory: Memory;
  reason: string;
}

// Snapshot-before-mutate: copy each affected file into snapshots/ so /undo can
// restore it. Returns the snapshot paths keyed by original file.
export async function snapshotFiles(files: string[]): Promise<string[]> {
  await ensureDir(snapshotDir());
  const stamp = Date.now();
  const snaps: string[] = [];
  for (const file of files) {
    const f = Bun.file(file);
    if (!(await f.exists())) continue;
    const snap = join(snapshotDir(), `${stamp}-${basename(file)}`);
    await Bun.write(snap, await f.text());
    snaps.push(snap);
  }
  return snaps;
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
      reason,
    }),
  );
}

export interface PruneResult {
  deleted: DeletedMemory[];
  snapshot: string[];
}

// Remove matching memories (used by memory_forget), snapshotting first and
// logging every deletion with its reason.
export async function prune(scope: string, type: string, reason: string): Promise<PruneResult> {
  const files = await memoryFiles();
  const snapshot = await snapshotFiles(files);
  const deleted: DeletedMemory[] = [];
  for (const file of files) {
    const lines = await readLines(file);
    const kept: string[] = [];
    let changed = false;
    for (const line of lines) {
      const parsed = parseLine(line);
      const m = parsed ? toMemory(parsed, file, 0) : null;
      if (m && m.scope === scope && m.type === type) {
        deleted.push({ memory: m, reason });
        await logDeletion(m, reason);
        changed = true;
        continue;
      }
      kept.push(line);
    }
    if (changed) await Bun.write(file, kept.join("\n") + (kept.length ? "\n" : ""));
  }
  return { deleted, snapshot };
}

export function isActive(m: Memory): boolean {
  return !m.superseded_by;
}
