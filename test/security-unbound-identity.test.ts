// Review follow-ups on #133 (probes 1, 3, 4 of the a8c5b7a follow-up review).
// A server process can host MORE THAN ONE plugin instance (multi-workspace
// host): setup() runs once per instance and the LAST one wins the module
// scope. Nothing a session's flow reads may then resolve through that module
// scope — the caller's own repository is either bound (session map) or this
// instance's own setup location, never "whoever loaded last". And a supersede
// field carried verbatim into a daily row must scrub at the write boundary
// like every other durable string (#128's rule, one line short).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { appendMemory } from "../src/store/files/append.ts"
import { loadAll } from "../src/store/files/load.ts";
import { resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { evidenceDir, memoryRoot } from "../src/core/config/paths.ts"
import { dateStr } from "../src/core/time.ts";

const TOKEN = "ghp_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

let root: string;
let a: string;
let b: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-unbound-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
  // ONE shared store for both instances: the worst case. Rows and evidence
  // interleave in the same files and separate ONLY by their repo stamp.
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  resetCaptureCooldowns();
  setRepoScope(null);
  plugins = [];
});

afterEach(async () => {
  for (const p of plugins) await p.cleanup();
  plugins = [];
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function seedPrivate(dir: string, marker: string): Promise<void> {
  const scope = resolveRepo(dir);
  await appendMemory({
    type: "context",
    scope: "planning",
    content: marker,
    status: "open", // frontier rows: the content itself rides the system prompt
    repo: scope.key,
    repoPath: scope.path,
  });
}

const injected = (parts: Array<{ type: string; text: string }>): string =>
  parts.map((p) => p.text).join("\n");

type ContextEvent = { sessionID: string; system: Array<{ type: string; text: string }> };

// Probe 1: load A, load B, then invoke A's REAL context hook for a session
// that was never bound. The module scope is B's repository — inheriting it
// leaks B's private frontier rows into A's system prompt.
test("an unbound session never inherits the LAST setup's repository", async () => {
  const pa = await loadPlugin(a);
  const pb = await loadPlugin(b);
  plugins = [pa, pb];
  await seedPrivate(b, "B_PRIVATE_AFTER_A");
  await seedPrivate(a, "A_OWN_REPO_ROW");

  const event: ContextEvent = { sessionID: "ses-a-never-bound", system: [] };
  await pa.sessionHooks.context(event);
  const text = injected(event.system);
  expect(text).not.toContain("B_PRIVATE_AFTER_A");
  // Fail-closed must not mean fail-silent: A's own repository still injects.
  expect(text).toContain("A_OWN_REPO_ROW");
});

// Probe 3: evidence is data, but data partitions too. B completes a tool call
// in the shared store; A's memory_evidence must not surface B's tool_result
// line (and A's own line must survive the filter).
test("memory_evidence answers from the caller's repository only", async () => {
  const pa = await loadPlugin(a);
  const pb = await loadPlugin(b);
  plugins = [pa, pb];

  await pb.toolHooks["execute.after"]?.({
    sessionID: "ses-b",
    callID: "call-b",
    tool: "read",
    input: { filePath: join(b, "notes.md") },
    result: { content: "B_PROBE3_PRIVATE_RESULT" },
  });
  await pa.toolHooks["execute.after"]?.({
    sessionID: "ses-a",
    callID: "call-a",
    tool: "read",
    input: { filePath: join(a, "notes.md") },
    result: { content: "A_PROBE3_OWN_RESULT" },
  });

  const res = await pa.tools.memory_evidence.execute(
    { ev: "tool_result" },
    { sessionID: "ses-a", id: "probe3-read" },
  );
  const out = String((res as { content?: string }).content ?? "");
  expect(out).toContain("A_PROBE3_OWN_RESULT");
  expect(out).not.toContain("B_PROBE3_PRIVATE_RESULT");
});

// Probe 4: the merge reason is scrubbed in the evidence line (#128) but
// rides into the LOSER'S daily row verbatim through the supersede fields.
// The store row is durable data too — scrub it at the same boundary.
test("a credential in a supersede reason never reaches the daily row", async () => {
  const p = await loadPlugin(a);
  plugins = [p];
  await appendMemory({
    type: "decision",
    scope: "design/merge",
    content: "PROBE4_WINNER_ROW",
    repo: resolveRepo(a).key,
    repoPath: resolveRepo(a).path,
  });
  await appendMemory({
    type: "decision",
    scope: "design/merge",
    content: "PROBE4_LOSER_ROW",
    repo: resolveRepo(a).key,
    repoPath: resolveRepo(a).path,
  });
  const rows = await loadAll();
  const ts = (marker: string): string =>
    (rows.find((m) => m.content.includes(marker)) as { ts: string }).ts;

  const res = await p.tools.memory_merge_review.execute(
    { loser: ts("PROBE4_LOSER_ROW"), survivor: ts("PROBE4_WINNER_ROW"), reason: `consolidated, key ${TOKEN} rotated` },
    { sessionID: "ses-merge", id: "probe4-merge" },
  );
  expect(String((res as { content?: string }).content ?? "")).toContain("Resolved merge");

  const daily = readFileSync(join(memoryRoot(), `${dateStr()}.logfmt`), "utf8");
  expect(daily).toContain("PROBE4_LOSER_ROW"); // the row itself is there...
  expect(daily).not.toContain(TOKEN); // ...the credential inside its reason is not
  const evidence = readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8");
  expect(evidence).not.toContain(TOKEN);
});

// Probe 2 (#131 through the #127 lens): the merge authorization resolves the
// caller through the same identity plumbing — with A loaded FIRST and B's
// repository sitting in the shared store, A's real merge tool called for an
// unbound session must not get to retire B's rows. Red at c9791ed, where
// readerForSession borrowed B's module scope and owned B's data.
test("an unbound session cannot retire another repository's rows through merge", async () => {
  const pa = await loadPlugin(a);
  const pb = await loadPlugin(b);
  plugins = [pa, pb];
  const scopeB = resolveRepo(b);
  await appendMemory({
    type: "decision",
    scope: "design/b",
    content: "B_MERGE_WINNER",
    repo: scopeB.key,
    repoPath: scopeB.path,
  });
  await appendMemory({
    type: "decision",
    scope: "design/b",
    content: "B_MERGE_LOSER",
    repo: scopeB.key,
    repoPath: scopeB.path,
  });
  const rows = await loadAll();
  const ts = (marker: string): string =>
    (rows.find((m) => m.content.includes(marker)) as { ts: string }).ts;
  const loserTs = ts("B_MERGE_LOSER");

  const res = await pa.tools.memory_merge_review.execute(
    { loser: loserTs, survivor: ts("B_MERGE_WINNER"), reason: "cross-repo probe" },
    { sessionID: "ses-a-never-bound", id: "probe2-merge" },
  );
  expect(String((res as { content?: string }).content ?? "")).toContain("another repository");
  const loser = (await loadAll()).find((m) => m.ts === loserTs) as {
    superseded_by?: string;
  };
  expect(loser.superseded_by).toBeUndefined(); // B's row is untouched
});

// Probe 5: when the evidence write fails AFTER the rows were retired, the
// response must describe what actually happened — "nothing was done" is true
// only for the lock-acquisition failure it was written for.
test("a merge whose evidence write fails reports the retirement it actually made", async () => {
  const p = await loadPlugin(a);
  plugins = [p];
  // Poison the evidence path: the merge's mutation runs, its record() throws.
  // Cleared first in the SAME synchronous block: anything that already put a
  // directory there (host timing varies by platform — CI's Bun created one
  // during setup) loses to the poison, never the other way around.
  mkdirSync(memoryRoot(), { recursive: true });
  const poisoned = join(memoryRoot(), "evidence");
  rmSync(poisoned, { recursive: true, force: true });
  writeFileSync(poisoned, "not a directory");
  await appendMemory({
    type: "decision",
    scope: "design/probe5",
    content: "PROBE5_WINNER_ROW",
    repo: resolveRepo(a).key,
    repoPath: resolveRepo(a).path,
  });
  await appendMemory({
    type: "decision",
    scope: "design/probe5",
    content: "PROBE5_LOSER_ROW",
    repo: resolveRepo(a).key,
    repoPath: resolveRepo(a).path,
  });
  const rows = await loadAll();
  const ts = (marker: string): string =>
    (rows.find((m) => m.content.includes(marker)) as { ts: string }).ts;
  const loserTs = ts("PROBE5_LOSER_ROW");

  const res = await p.tools.memory_merge_review.execute(
    { loser: loserTs, survivor: ts("PROBE5_WINNER_ROW"), reason: "dupes" },
    { sessionID: "ses-p5", id: "probe5-merge" },
  );
  const out = String((res as { content?: string }).content ?? "");
  const loser = (await loadAll()).find((m) => m.ts === loserTs) as {
    superseded_by?: string;
  };
  expect(loser.superseded_by).toBeString(); // the mutation DID happen...
  // ...so the answer must own it, not claim the documented no-op contract.
  expect(out).not.toContain("nothing was done");
  expect(out.toLowerCase()).toContain("evidence");
});
