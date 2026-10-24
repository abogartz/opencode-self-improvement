// Durable memory store engine. Reproduces the opencode-memory logfmt format
// (MIT, github.com/shuans/opencode-memory; license retained under
// vendor/opencode-memory/LICENSE) and extends it with the fields the write-gate
// needs: supersession markers, snapshots and audited deletion.
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, basename } from "node:path";
import { dateStr, memoryRoot, deletionsFile, snapshotDir } from "./config.ts";
import { repoScopeFor } from "./repokey.ts";
import { getCurrent } from "./state.ts";
import {
  appendLog,
  ensureDir,
  fileIdentity,
  formatLine,
  parseLine,
  readLines,
  writeAtomic,
  type Fields,
} from "./logfmt.ts";
import { withStoreLock, LOCK_WRITE } from "./lock.ts";
import { blockedTs } from "./blocklist.ts";
import { containsSecret, redactSecrets } from "./secrets.ts";
import { flattenMemoryText } from "./sanitize.ts";

export type MemoryStatus = "open" | "settled";

// Hard ceiling on stored content. No entry point may persist a line longer
// than this: injection ever shows ~1200 chars, the gate runs on the shared
// service event loop, and regex scanning over megabyte-scale strings froze
// sessions (100KB write = 6s, 2MB = hang).
// Enforced twice — politely in runWriteGate (blocked outcome + evidence),
// absolutely in appendMemory (throws, covering gate-bypassing callers).
export const MAX_CONTENT_CHARS = 4000;

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
  // Origin repo: sha1 of the normalized origin URL, the toplevel
  // path when the repo had no remote, the literal "global" for cross-project
  // writes, or absent for legacy/viewer rows — all three read as described
  // in isVisibleHere().
  repo?: string;
  repoPath?: string;
  file: string;
  index: number;
}

const RESERVED = new Set([
  "deletions.logfmt",
  "deleted.logfmt",
  "canonical.logfmt",
  "blocklist.logfmt",
]);

// Row identity is `ts`: supersede chains, the blocklist, undo matching, and
// the viewer's action buttons all key off it. A row whose ts is
// not an ISO instant must never become an addressable live row — readers
// treat it as malformed: skipped, counted, warned once per file. The shape
// check lives here (the store knows its schema); logfmt stays a dumb parser.
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
let malformedRows = 0;
const malformedWarnedFiles = new Set<string>();

/** Rows skipped as malformed by the most recent store read (approximate, in-process). */
export function malformedCount(): number {
  return malformedRows;
}

function toMemory(fields: Record<string, unknown>, file: string, index: number): Memory | null {
  const ts = fields.ts;
  const type = fields.type;
  const scope = fields.scope;
  if (typeof ts !== "string" || typeof type !== "string") return null;
  if (typeof scope !== "string") return null;
  if (!ISO_TS_RE.test(ts) || Number.isNaN(Date.parse(ts))) {
    malformedRows++;
    if (!malformedWarnedFiles.has(file)) {
      malformedWarnedFiles.add(file);
      console.warn(
        `[memory] malformed row skipped in ${file} (ts is not an ISO instant): ${JSON.stringify(ts.slice(0, 48))}`,
      );
    }
    return null;
  }
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
    repo: typeof fields.repo === "string" ? fields.repo : undefined,
    repoPath: typeof fields.repoPath === "string" ? fields.repoPath : undefined,
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
  malformedRows = 0; // per-load telemetry: the most recent read wins
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
  // Gate dedup/stale reads are repo-scoped: a row from another repo must not
  // collapse or supersede a write here.
  return (await loadAll()).filter((m) => m.scope === scope && isVisibleHere(m));
}

export interface AppendMemoryInput {
  type: string;
  scope: string;
  content: string;
  issue?: string;
  tags?: string[];
  status?: MemoryStatus;
  // "global" for explicit cross-project writes; imports may carry a validated
  // same-repo origin stamp (see portable.ts). Any missing value is resolved by
  // appendMemory against the live repo scope.
  repo?: string;
  repoPath?: string;
}

// ts values already in `file`. An appended row's ts is "now", so the only rows
// it can collide with are ones this same file received in the same millisecond;
// scanning just it keeps the locked section to one read of one file. (A row
// hand-placed with today's ts in another day's file is outside this promise.)
async function existingTs(file: string): Promise<Set<string>> {
  const set = new Set<string>();
  for (const line of await readLines(file)) {
    const f = parseLine(line);
    if (f && typeof f.ts === "string") set.add(f.ts);
  }
  return set;
}

// Append a durable memory. GATE-4 promotions and the viewer's edit/restore-entry
// paths all call this single write choke point.
export async function appendMemory(input: AppendMemoryInput): Promise<string> {
  // Absolute floor: every write SHOULD arrive through the gate,
  // which rejects invalid input politely; viewer writes do not, so enforce the
  // same storage rules here before anything reaches disk.
  if (typeof input.content !== "string") throw new Error("memory content must be a string");
  if (input.content.length > MAX_CONTENT_CHARS) {
    throw new Error(`memory content exceeds ${MAX_CONTENT_CHARS} chars (${input.content.length})`);
  }
  for (const [field, value] of [
    ["type", input.type],
    ["scope", input.scope],
    ["issue", input.issue],
  ] as const) {
    if (value !== undefined && flattenMemoryText(value) !== value) {
      throw new Error(`memory ${field} must not contain control characters`);
    }
  }
  if (input.tags?.some((tag) => flattenMemoryText(tag) !== tag)) {
    throw new Error("memory tags must not contain control characters");
  }
  const credentialMetadata = [
    containsSecret(input.scope) ? "scope" : undefined,
    input.tags?.some(containsSecret) ? "tags" : undefined,
    containsSecret(input.issue) ? "issue" : undefined,
  ].filter((field): field is string => field !== undefined);
  if (credentialMetadata.length) {
    throw new Error(
      `memory metadata contains credential-shaped value in: ${credentialMetadata.join(", ")}`,
    );
  }
  const content = redactSecrets(input.content);
  // Repo stamp at the single write choke point: gated writes plus viewer edits
  // and restore-entry writes all pass through here. Explicit "global" survives;
  // an unscoped process (viewer) stamps nothing = global. Session identity wins
  // over the module scope so a server hosting several workspaces stamps the
  // writing session's repo.
  let repo = input.repo;
  let repoPath = input.repoPath;
  if (repo === undefined) {
    const cur = repoScopeFor(getCurrent().sid);
    if (cur) {
      repo = cur.key;
      repoPath = cur.path;
    }
  }
  // Day file chosen before the lock (it IS the lock key). A ts bumped across
  // midnight therefore lands under the previous day's name; readers glob every
  // file and decay compares ts values, so the grouping is cosmetic.
  const file = join(memoryRoot(), `${dateStr()}.logfmt`);
  // Locked end to end: seeding ts from a scan another process can race yields
  // two rows with the same identity, and an append that lands inside someone
  // else's whole-file rewrite is simply not there afterwards.
  return withStoreLock(file, async () => {
    const taken = await existingTs(file);
    let ts = new Date().toISOString();
    let guard = 0;
    while (taken.has(ts) && guard++ < 1000) {
      ts = new Date(new Date(ts).getTime() + 1).toISOString();
    }
    await appendLog(
      file,
      formatLine({
        ts,
        type: input.type,
        scope: input.scope,
        content,
        issue: input.issue,
        tags: input.tags?.length ? input.tags.join(",") : undefined,
        status: input.status,
        repo,
        repoPath,
      }),
    );
    return ts;
  }, LOCK_WRITE);
}

export interface SupersedeFields {
  superseded_by: string;
  reason: string;
  symbol?: string;
  from?: string;
  to?: string;
  entity?: string;
}

// Copy `file` into snapshots/ before a mutation.
async function snapshotBefore(file: string): Promise<void> {
  await snapshotFiles([file]);
}

// Read-modify-write ONE row of a store file: read, rewrite the line, publish
// atomically, all under the store lock, so an append or another rewrite by a
// concurrent session cannot be overwritten by our stale copy. Resolves to null
// when the row is not in this file, otherwise the mutation's outcome.
async function stampRow(
  file: string,
  ts: string,
  mutate: (fields: Fields) => string | null,
): Promise<boolean | null> {
  return withStoreLock(
    file,
    async () => {
      // Identity BEFORE the read: it pins the state `lines` was derived from,
      // so writeAtomic can refuse to publish if anything moved the file
      // meanwhile (Windows retry path — see logfmt.ts handoverRename).
      const since = await fileIdentity(file);
      const lines = await readLines(file);
      const idx = lines.findIndex((l) => {
        const f = parseLine(l);
        return f && f.ts === ts;
      });
      if (idx === -1) return null;
      const parsed = parseLine(lines[idx]);
      if (!parsed) return false;
      const next = mutate(parsed);
      if (next === null) return false;
      lines[idx] = next;
      await snapshotBefore(file);
      await writeAtomic(file, lines.join("\n") + "\n", since);
      return true;
    },
    LOCK_WRITE,
  );
}

// Mark an existing memory as superseded IN PLACE (entry retained, recoverable).
// Idempotent: a second call is a no-op, so no double `superseded_by`.
export async function markSuperseded(ts: string, fields: SupersedeFields): Promise<boolean> {
  for (const file of await memoryFiles()) {
    // The whole line is rewritten rather than extended, so an old-format line
    // comes out in the current format with its values unchanged.
    const outcome = await stampRow(file, ts, (parsed) =>
      typeof parsed.superseded_by === "string" ? null : formatLine({ ...parsed, ...fields }),
    );
    if (outcome !== null) return outcome;
  }
  return false;
}

// Drop a row's supersession markers IN PLACE (snapshot-first), making it active
// again. Used by memory_merge_review: a declared survivor must be recallable
// even when an earlier row — now the loser — had superseded it first.
export async function clearSuperseded(ts: string): Promise<boolean> {
  for (const file of await memoryFiles()) {
    const outcome = await stampRow(file, ts, (parsed) => {
      if (typeof parsed.superseded_by !== "string") return null;
      // These five keys are written only by markSuperseded (drift, canonical,
      // update and merge_review), never by appendMemory, so they are all part of
      // the marker and go with it. Field order round-trips because parseLine
      // inserts keys in source order.
      for (const key of ["superseded_by", "reason", "symbol", "from", "to", "entity"]) {
        delete parsed[key];
      }
      return formatLine(parsed);
    });
    if (outcome !== null) return outcome;
  }
  return false;
}

export type TargetResolution =
  | { status: "ok"; target: Memory }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: Memory[] };

// Score one row against a query: exact row id first, then content.
function targetScore(m: Memory, query: string): number {
  const ts = m.ts.toLowerCase();
  if (ts === query) return 100;
  // A clock fragment ("00:11:25.867") is unique enough to identify a row.
  if (query.length >= 8 && ts.includes(query)) return 95;
  const content = m.content.toLowerCase();
  if (content === query) return 90;
  if (content.includes(query)) return 80;
  if (query.includes(content)) return 70;
  return 0;
}

// Pick the row an update/merge call means. Without a query the caller keeps the
// legacy "most recent active row of this scope+type" behaviour; with one, a
// miss or a tie fails CLOSED rather than silently rewriting a different row.
export function resolveMemoryTarget(rows: Memory[], query?: string): TargetResolution {
  if (!query || !query.trim()) {
    const last = rows[rows.length - 1];
    return last ? { status: "ok", target: last } : { status: "not_found" };
  }
  const q = query.trim().toLowerCase();
  let best: Memory | undefined;
  let bestScore = 0;
  const tied: Memory[] = [];
  for (const m of rows) {
    const score = targetScore(m, q);
    if (score > bestScore) {
      best = m;
      bestScore = score;
      tied.length = 0;
      tied.push(m);
    } else if (score === bestScore && score > 0) {
      tied.push(m);
    }
  }
  if (!best) return { status: "not_found" };
  if (tied.length > 1) return { status: "ambiguous", candidates: tied };
  return { status: "ok", target: best };
}

export interface DeletedMemory {
  memory: Memory;
  reason: string;
}

// Claim a snapshot name with O_EXCL so "never overwrite a snapshot" holds
// across processes, not just inside one: two sessions mutating the same file in
// one millisecond both bump instead of one clobbering the other's still-undoable
// copy. Names are `<epoch-ms>-<original>` because /undo strips the leading stamp
// to find its target, so nothing may go in front of it.
async function claimSnapshot(file: string): Promise<string> {
  await ensureDir(snapshotDir());
  let stamp = Date.now();
  for (;;) {
    const snap = join(snapshotDir(), `${stamp}-${basename(file)}`);
    try {
      const handle = await open(snap, "wx");
      await handle.close();
      return snap;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      stamp++;
    }
  }
}

// Snapshot-before-mutate: copy each affected file into snapshots/ so /undo can
// restore it. Returns the snapshot paths keyed by original file.
export async function snapshotFiles(files: string[]): Promise<string[]> {
  const snaps: string[] = [];
  for (const file of files) {
    const f = Bun.file(file);
    if (!(await f.exists())) continue;
    const snap = await claimSnapshot(file);
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
// logging every deletion with its reason. Each file is filtered and republished
// under the store lock, so a row another session appended while we were reading
// is not quietly filtered out along with the targets.
export async function prune(scope: string, type: string, reason: string): Promise<PruneResult> {
  const deleted: DeletedMemory[] = [];
  const snapshot: string[] = [];
  for (const file of await memoryFiles()) {
    await withStoreLock(
      file,
      async () => {
        const since = await fileIdentity(file);
        const lines = await readLines(file);
        const kept: string[] = [];
        let changed = false;
        for (const line of lines) {
          const parsed = parseLine(line);
          const m = parsed ? toMemory(parsed, file, 0) : null;
          // Repo floor: forgetting scope X here must never delete
          // another repo's row for scope X — same basename collisions are real
          // (a fork next to its upstream).
          if (m && m.scope === scope && m.type === type && isVisibleHere(m)) {
            deleted.push({ memory: m, reason });
            await logDeletion(m, reason);
            changed = true;
            continue;
          }
          kept.push(line);
        }
        if (!changed) return;
        snapshot.push(...(await snapshotFiles([file])));
        await writeAtomic(file, kept.join("\n") + (kept.length ? "\n" : ""), since);
      },
      LOCK_WRITE,
    );
  }
  return { deleted, snapshot };
}

export function isActive(m: Memory): boolean {
  return !m.superseded_by;
}

// The ONLY repo filter the model-facing paths use (injection sinks, recall,
// list, update targeting, prune, decay, gate scope reads). A row is visible
// when it is global (explicit marker OR no stamp — legacy rows and writes by
// processes with no scope, e.g. the viewer), or was written in this repo.
// Keeping it one predicate is what stops the filtering from drifting between
// entry points.
export function isVisibleHere(m: Memory): boolean {
  if (!m.repo || m.repo === "global") return true;
  const cur = repoScopeFor(getCurrent().sid);
  if (!cur) return true; // unscoped process: no partitioning
  return m.repo === cur.key || (!!m.repoPath && m.repoPath === cur.path);
}

// Rows visible to the current process (active filtering stays with callers).
export function visibleHere(mems: Memory[]): Memory[] {
  return mems.filter(isVisibleHere);
}
