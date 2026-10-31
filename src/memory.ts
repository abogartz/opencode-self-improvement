// Durable memory store engine. Reproduces the opencode-memory logfmt format
// (MIT, github.com/shuans/opencode-memory; license retained under
// vendor/opencode-memory/LICENSE) and extends it with the fields the write-gate
// needs: supersession markers, snapshots and audited deletion.
import { existsSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { dateStr, memoryRoot, deletionsFile, snapshotDir, HITS_FILENAME } from "./config.ts";
import { repoScopeFor, sessionScope, writeTarget, type RepoScope } from "./repokey.ts";
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
import { tombstoneMany } from "./tombstones.ts";
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

/** How many retrieval keywords a row may carry, and how long each one may be. */
export const MAX_KEYWORDS = 8;
export const MAX_KEYWORD_CHARS = 48;

/**
 * Normalise author-supplied retrieval keywords: trim, lowercase, split on the
 * storage delimiter, de-duplicate, drop empties and over-long entries, cap the
 * count. TOTAL on purpose — junk yields a shorter list rather than a throw,
 * because keywords only ever widen recall and must never be able to fail a
 * write the prose alone deserved.
 */
export function normalizeKeywords(kw: unknown): string[] | undefined {
  if (!Array.isArray(kw)) return undefined;
  const out: string[] = [];
  for (const item of kw) {
    if (typeof item !== "string") continue;
    // Commas are the storage delimiter (kw serialises as one comma-joined
    // scalar), so an item carrying one would read back fragmented. Treat them
    // as separators: "build, test" becomes two aliases, never a " test".
    for (const part of item.split(",")) {
      const k = part.trim().toLowerCase();
      if (!k || k.length > MAX_KEYWORD_CHARS) continue;
      if (!out.includes(k)) out.push(k);
      if (out.length === MAX_KEYWORDS) break;
    }
    if (out.length === MAX_KEYWORDS) break;
  }
  return out.length ? out : undefined;
}


export interface Memory {
  ts: string;
  type: string;
  scope: string;
  content: string;
  issue?: string;
  tags?: string[];
  // Retrieval keywords (#40): author-supplied aliases, verb forms and synonyms
  // for this row, written at capture time. They widen the scoring haystack
  // ONLY — a row is never rendered through them, so injection bytes and the
  // content cap stay exactly what the prose says. This is the zero-embedding
  // answer to the bench's strict-paraphrase wall (0% R@1: the user's words are
  // not the memory's words).
  kw?: string[];
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
  // Value-keyed rejection tombstones (#35). Hashes only, never prose — and it
  // must never be ingested as a row, exported, or restored by undo.
  "rejected.logfmt",
  // The use ledger (src/hits.ts): telemetry, not memory. A hit line must never
  // be able to become a row — or to be superseded, exported, or injected.
  HITS_FILENAME,
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
    kw: typeof fields.kw === "string" && fields.kw
      ? fields.kw.split(",").map((k) => k.trim()).filter((k) => k.length > 0)
      : undefined,
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

export async function loadScope(scope: string, reader: Reader = readerForAmbient()): Promise<Memory[]> {
  // Gate dedup/stale reads are repo-scoped: a row from another repo must not
  // collapse or supersede a write here. The reader is the CALLER's identity,
  // resolved at flow entry — not whatever current says after this await.
  return (await loadAll()).filter((m) => m.scope === scope && isVisibleTo(m, reader));
}

export interface AppendMemoryInput {
  type: string;
  scope: string;
  content: string;
  issue?: string;
  tags?: string[];
  /** Retrieval keywords (#40); normalised and capped by appendMemory. */
  kw?: string[];
  status?: MemoryStatus;
  // "global" for explicit cross-project writes; imports may carry a validated
  // same-repo origin stamp (see portable.ts). Any missing value is resolved by
  // appendMemory against the live repo scope.
  repo?: string;
  repoPath?: string;
  // Which session the write belongs to, when the caller knows it (the gate
  // threads it from GateContext, #116). Preferred over the ambient current.
  sessionID?: string;
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

// #152: the store's answer to a write whose owner it cannot determine. Thrown
// from the one place that knows what an owner is (the stamp resolution below),
// so no caller — gate, import, capture, or a future one — can quietly persist
// an ownerless row. `unresolvedWriteMessage` is the same text the model-facing
// tools return, kept here so the two can never drift.
export function unresolvedWriteMessage(sid: string): string {
  return (
    `Write refused: session ${sid} has no resolvable repository, so nothing was stored. ` +
    `A memory with no owner must not be stamped into another repository or published as a ` +
    `global row. Retry from a session in the project you mean, or pass global:true for a ` +
    `deliberate cross-project memory.`
  );
}

export class UnresolvedWriterError extends Error {
  /** The named-but-unresolved session whose write was refused. */
  sid: string;
  constructor(sid: string) {
    super(unresolvedWriteMessage(sid));
    this.name = "UnresolvedWriterError";
    this.sid = sid;
  }
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
  // Keywords are indexed, never rendered, but they still live on the row's
  // single line, so the same control-character floor applies.
  if (input.kw?.some((k) => typeof k !== "string" || flattenMemoryText(k) !== k)) {
    throw new Error("memory keywords must not contain control characters");
  }
  const credentialMetadata = [
    containsSecret(input.scope) ? "scope" : undefined,
    input.tags?.some(containsSecret) ? "tags" : undefined,
    input.kw?.some(containsSecret) ? "kw" : undefined,
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
    // The caller's session when it named one: capture awaits a model call, and
    // the last setCurrent before persistence may belong to another session
    // entirely (#116). Unnamed writers (tools, viewer, restore) keep the
    // ambient binding.
    //
    // A NAMED session that never resolved a repository is not an unnamed one
    // (#152): falling back to the module scope stamped its rows into whatever
    // workspace set up last, and with no module scope at all it stamped nothing
    // — which every reader calls global. Both outcomes publish private content
    // somewhere its owner can no longer see it, so the store refuses the write
    // instead of guessing an owner. Tools answer with this message before the
    // gate runs; throwing here is what covers every caller, including ones that
    // reach the store without a tool.
    const target = writeTarget(input.sessionID ?? getCurrent().sid);
    if (!target.ok) throw new UnresolvedWriterError(target.sid);
    if (target.scope) {
      repo = target.scope.key;
      repoPath = target.scope.path;
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
    const kw = normalizeKeywords(input.kw);
    await appendLog(
      file,
      formatLine({
        ts,
        type: input.type,
        scope: input.scope,
        content,
        issue: input.issue,
        tags: input.tags?.length ? input.tags.join(",") : undefined,
        kw: kw?.join(","),
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
export async function markSuperseded(ts: string, fields: SupersedeFields, durable?: string[]): Promise<boolean> {
  return (await markManySupersededReport([{ ts, fields }], durable)).marked.length > 0;
}

// Batch supersession (#61): one lock acquisition, one read, one snapshot and
// one publish PER FILE touched - N rows retire as one undo point instead of
// N. decay and the gate's drift/canonical loops used to call markSuperseded
// per row, which meant N full read-modify-write cycles, N undo points, and
// N windows where two runs interleave and each re-pays the other's work.
// Idempotence is unchanged: a row already carrying superseded_by is skipped,
// so a repeat run marks nothing and writes nothing. Duplicate ts entries in
// one batch: the FIRST entry's fields win (mirrors row-by-row first-call-wins).
// Returns the number of rows actually marked.
export async function markManySuperseded(entries: { ts: string; fields: SupersedeFields }[], durable?: string[]): Promise<number> {
  return (await markManySupersededReport(entries, durable)).marked.length;
}

// Same operation, reporting WHICH rows retired rather than how many (#158
// round 3): the write gate needs the ids to keep a durable-mutation ledger,
// because a failed audit line after a persisted retirement must still be able
// to name what actually landed. Skipped-by-the-batch rows (already retired
// out of band) are absent from `marked` — the ledger never claims a retirement
// this call did not perform.
export async function markManySupersededReport(
  entries: { ts: string; fields: SupersedeFields }[],
  // Updated immediately after EACH publish, even if a later file refuses its
  // lock or lock cleanup throws. A rejected promise is not a rollback.
  durable?: string[],
): Promise<{ marked: string[] }> {
  if (entries.length === 0) return { marked: [] };
  const wanted = new Map<string, SupersedeFields>();
  for (const e of entries) if (!wanted.has(e.ts)) wanted.set(e.ts, e.fields);
  const marked: string[] = [];
  for (const file of await memoryFiles()) {
    marked.push(
      ...(await withStoreLock(
        file,
        async () => {
        // #106: identity BEFORE the read, like every other whole-file
        // read-modify-write (#89's contract) - the publish below may retry a
        // Windows handover only while the destination still matches this.
          const since = await fileIdentity(file);
          const lines = await readLines(file);
          const ids: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            const parsed = parseLine(lines[i]);
            if (!parsed || typeof parsed.superseded_by === "string") continue;
            const fields = typeof parsed.ts === "string" ? wanted.get(parsed.ts) : undefined;
            if (!fields) continue;
            // Whole line rewritten, not extended: an old-format line comes out in
            // the current format with its values unchanged (as markSuperseded did).
            // The one exception is SECRET SCRUB (#128, review probe 4): the
            // fields a merge/decay/update copies into the loser's row carry
            // caller-authored prose (the rotation note "key ghp_... rotated"),
            // and content already scrubs at this same boundary (line 260). The
            // durable row must not be the one place a credential survives when
            // the evidence line beside it was cleaned.
            const clean: SupersedeFields = { ...fields };
            for (const k of Object.keys(clean)) {
              const v = (clean as unknown as Record<string, unknown>)[k];
              if (typeof v === "string") (clean as unknown as Record<string, unknown>)[k] = redactSecrets(v);
            }
            lines[i] = formatLine({ ...parsed, ...clean });
            ids.push(parsed.ts as string);
          }
          if (ids.length === 0) return [];
          await snapshotBefore(file);
          await writeAtomic(file, lines.join("\n") + "\n", since);
          durable?.push(...ids);
          return ids;
        },
        LOCK_WRITE,
      ))
    );
  }
  // A ts that appears in several files (should not exist - append mints unique
  // ts) retires in EVERY file here, where the row-by-row loop retired only the
  // first; both are conservation-safe, this one is the more honest tombstone.
  return { marked };
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
    let contents: Buffer;
    try {
      contents = await readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const snap = await claimSnapshot(file);
    await Bun.write(snap, contents);
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
      // Origin survives the delete/restore round trip (#129): a restore-entry
      // made from this line re-stamps what the row carried. A row with no
      // stamp writes no stamp here — the legacy global path, unchanged.
      repo: memory.repo,
      repoPath: memory.repoPath,
      reason: redactSecrets(reason),
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
// is not quietly filtered out along with the targets. The reader is the
// caller's captured identity (#127); out-of-plugin callers keep ambient.
export async function prune(
  scope: string,
  type: string,
  reason: string,
  reader: Reader = readerForAmbient(),
  durable: PruneResult = { deleted: [], snapshot: [] },
): Promise<PruneResult> {
  const { deleted, snapshot } = durable;
  for (const file of await memoryFiles()) {
    await withStoreLock(
      file,
      async () => {
        const since = await fileIdentity(file);
        const lines = await readLines(file);
        const kept: string[] = [];
        const fileDeleted: DeletedMemory[] = [];
        let changed = false;
        for (const line of lines) {
          const parsed = parseLine(line);
          const m = parsed ? toMemory(parsed, file, 0) : null;
          // Repo floor: forgetting scope X here must never delete
          // another repo's row for scope X — same basename collisions are real
          // (a fork next to its upstream).
          if (m && m.scope === scope && m.type === type && isVisibleTo(m, reader)) {
            fileDeleted.push({ memory: m, reason });
            await logDeletion(m, reason);
            changed = true;
            continue;
          }
          kept.push(line);
        }
        if (!changed) return;
        snapshot.push(...(await snapshotFiles([file])));
        await writeAtomic(file, kept.join("\n") + (kept.length ? "\n" : ""), since);
        deleted.push(...fileDeleted);
      },
      LOCK_WRITE,
    );
  }
  // #35: tombstone every forgotten VALUE, keyed on content rather than on the
  // row's `ts`, so replaying the source cannot store the fact again.
  //
  // ONE batched call, not one per row: `memory_forget` deletes by scope+type and
  // routinely removes hundreds of rows, and the per-row form issued a store-lock
  // create/unlink pair plus a full re-read of the tombstone file for each one.
  // Done AFTER the per-file locks are released as well — appending inside the
  // loop would nest a second store lock (day file, then rejected.logfmt) inside
  // the first, and one consistent order across the codebase is what keeps the
  // lock manager from having to reason about nesting at all.
  await tombstoneMany(
    deleted.map((d) => ({
      content: d.memory.content,
      scope: d.memory.scope,
      type: d.memory.type,
    })),
    { reason, source: "forget" },
  );
  return { deleted, snapshot };
}

export function isActive(m: Memory): boolean {
  return !m.superseded_by;
}

// --- repo visibility ---------------------------------------------------------
// A READER is an immutable caller identity, resolved once at the entry of a
// flow (a hook, a tool call, a viewer route) and carried through every await
// in that flow. Resolution must NOT be deferred to filter time: the module
// global current moves whenever another session's hook or tool dispatches, and
// a store read awaits filesystem I/O — filtering after the await with the
// ambient identity injects the OTHER session's repo (#127).
//
//   repo        — the caller's session resolved a repository (its own when
//                 bound; the setup location for an unbound session in a
//                 single-workspace plugin, exactly the historical semantics).
//   global-only — a plugin flow whose caller identity names no repository:
//                 explicit/legacy global rows ONLY. This is the fail-closed
//                 answer for an unbound session on a serve host; "unknown"
//                 is never "everything".
//   admin       — explicit all-repositories access: the standalone viewer and
//                 out-of-plugin maintenance callers. Administrative breadth is
//                 a property of the entry point, never of a missing session.
export type Reader =
  | { kind: "repo"; scope: RepoScope }
  | { kind: "global-only" }
  | { kind: "admin" };

/** Explicit all-repositories identity (viewer routes, CLI maintenance). */
export const ADMIN_READER: Reader = { kind: "admin" };

// Reader for a plugin-session flow, resolved from the caller's OWN session id
// captured synchronously at flow entry. Bound session → its repo; unbound →
// global-only. The module scope is NOT a fallback here: in a process that
// loaded more than one plugin instance it belongs to whoever set up LAST,
// which is another workspace (#127's multi-setup gap). Plugin flows bind an
// unbound caller to their OWN setup location at entry (index.ts), so ordinary
// single-workspace sessions resolve through the session map, never here.
export function readerForSession(sid?: unknown): Reader {
  const scope = sessionScope(sid);
  return scope ? { kind: "repo", scope } : { kind: "global-only" };
}

// The historical AMBIENT reader: live session, then module scope, and no
// scope at all reads as unpartitioned. Correct only for out-of-plugin callers
// (viewer, scripts, unit tests) with no concurrent sessions; model-facing
// plugin paths carry a Reader instead of using this.
export function readerForAmbient(): Reader {
  const scope = repoScopeFor(getCurrent().sid);
  return scope ? { kind: "repo", scope } : { kind: "admin" };
}

// Ambient-style entry points take an optional sid: a real session id resolves
// fail-closed through readerForSession; "?" or absent keeps legacy semantics.
export function readerFromSid(sid?: unknown): Reader {
  return typeof sid === "string" && sid !== "" && sid !== "?"
    ? readerForSession(sid)
    : readerForAmbient();
}

// The ONLY repo filter every read path uses (injection sinks, recall, list,
// update targeting, prune, decay, gate scope reads). A row is visible when it
// is global (explicit marker OR no stamp — legacy rows and writes by
// processes with no scope, e.g. the viewer), or was written in the reader's
// repo. Keeping it one predicate is what stops the filtering from drifting
// between entry points.
export function isVisibleTo(m: Pick<Memory, "repo" | "repoPath">, reader: Reader): boolean {
  if (reader.kind === "admin") return true;
  if (!m.repo || m.repo === "global") return true;
  if (reader.kind === "global-only") return false;
  return m.repo === reader.scope.key || (!!m.repoPath && m.repoPath === reader.scope.path);
}

export function visibleTo(mems: Memory[], reader: Reader): Memory[] {
  return mems.filter((m) => isVisibleTo(m, reader));
}

// The day-file twin of isVisibleTo for whole-file paths (undo/restore) that
// work on raw logfmt lines instead of parsed rows: the SAME predicate, with the
// rows' rule that a line with no stamp is a legacy row, not a private one —
// which is exactly the rule the evidence lines do NOT share, and the reason
// these are not one function. An unparseable line has no stamp, so it reads
// legacy-global rather than silently vanishing under a restore.
export function lineVisibleTo(line: string, reader: Reader): boolean {
  if (reader.kind === "admin") return true;
  const fields = parseLine(line);
  return isVisibleTo(
    {
      repo: typeof fields?.repo === "string" ? fields.repo : undefined,
      repoPath: typeof fields?.repoPath === "string" ? fields.repoPath : undefined,
    },
    reader,
  );
}

// The evidence-line twin of isVisibleTo, plus the one rule rows do not need:
// a missing stamp is NOT the same as a global marker. An explicitly
// `repo=global` line is global, and a line with no stamp AND no named
// session (legacy, or an out-of-plugin maintenance write) keeps its
// historical global reading. But a line a NAMED session wrote while its
// repository was unresolvable (evidence.ts) belongs to that session alone —
// visible back to the same session and to the admin surface, never to a
// stranger's memory_evidence. `callerSid` is the reading session's own id
// captured at flow entry; without it the private branch can only fail
// closed (admin sees all, everyone else does not).
export function evidenceVisibleTo(
  fields: Record<string, unknown>,
  reader: Reader,
  callerSid?: unknown,
): boolean {
  if (reader.kind === "admin") return true;
  const repo = fields.repo;
  if (typeof repo === "string" && repo !== "") {
    if (repo === "global") return true;
    if (reader.kind === "global-only") return false;
    const repoPath = fields.repoPath;
    return (
      repo === reader.scope.key ||
      (typeof repoPath === "string" && !!repoPath && repoPath === reader.scope.path)
    );
  }
  const sid = fields.sid;
  if (typeof sid === "string" && sid !== "" && sid !== "?") {
    return typeof callerSid === "string" && callerSid === sid;
  }
  return true;
}

// Ambient (out-of-plugin) convenience: resolves the reader at CALL time.
// Plugin paths must pass an explicit Reader/sid instead of relying on this.
export function isVisibleHere(m: Memory): boolean {
  return isVisibleTo(m, readerForAmbient());
}

// Rows visible to the current process (active filtering stays with callers).
export function visibleHere(mems: Memory[]): Memory[] {
  return mems.filter(isVisibleHere);
}
