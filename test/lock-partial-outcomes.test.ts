import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { canonicalFile, dateStr, evidenceDir, memoryRoot } from "../src/config.ts";
import { formatLine, parseLine } from "../src/logfmt.ts";
import { loadAll, markManySupersededReport, snapshotFiles } from "../src/memory.ts";
import { LOCK_RESTORE, LOCK_WRITE, lockFileFor, withStoreLock } from "../src/lock.ts";
import { restoreSnapshot } from "../src/undo.ts";
import { editMemory } from "../src/viewer/mutate.ts";
import { resetSessionScopes, setRepoScope } from "../src/repokey.ts";
import { resetState } from "../src/state.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { resetCaptureCooldowns } from "../src/index.ts";

let root: string;
let plugins: LoadedPlugin[];
const writeBudget = LOCK_WRITE.timeoutMs;
const restoreBudget = LOCK_RESTORE.timeoutMs;
const first = "2026-01-01T00:00:00.000Z";
const second = "2026-01-02T00:00:00.000Z";
const path = (ts: string) => join(memoryRoot(), `${ts.slice(0, 10)}.logfmt`);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-partial-lock-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(memoryRoot(), { recursive: true });
  resetState(); resetSessionScopes(); setRepoScope(null);
  resetCaptureCooldowns();
  LOCK_WRITE.timeoutMs = 40; LOCK_RESTORE.timeoutMs = 40;
  plugins = [];
});
afterEach(async () => {
  for (const plugin of plugins) await plugin.cleanup();
  LOCK_WRITE.timeoutMs = writeBudget; LOCK_RESTORE.timeoutMs = restoreBudget;
  resetState(); resetSessionScopes(); setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR; delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
function seed(ts: string, content: string) {
  writeFileSync(path(ts), formatLine({ ts, type: "context", scope: "planning", content, status: "open", repo: "global" }) + "\n");
}
async function plugin() {
  const p = await loadPlugin(root); plugins.push(p); return p;
}
async function held(file: string, run: () => Promise<void>) {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>((r) => { enter = r; });
  const released = new Promise<void>((r) => { release = r; });
  const holder = withStoreLock(file, async () => { enter(); await released; }, LOCK_WRITE);
  await entered;
  const owner = readFileSync(lockFileFor(file), "utf8");
  try { await run(); expect(readFileSync(lockFileFor(file), "utf8")).toBe(owner); }
  finally { release(); await holder; }
}
const ctx = { sessionID: "partial-lock", id: "partial-lock-call" };

test("a batch retains the first file's durable receipt when the next file is busy", async () => {
  seed(first, "first row"); seed(second, "second row");
  const durable: string[] = [];
  const before = readFileSync(path(second), "utf8");
  await held(path(second), async () => {
    await expect(markManySupersededReport([first, second].map((ts) => ({ ts, fields: { superseded_by: "survivor", reason: "probe" } })), durable)).rejects.toThrow(basename(path(second)));
    expect(durable).toEqual([first]);
    expect((await loadAll()).find((row) => row.ts === first)?.superseded_by).toBe("survivor");
    expect(readFileSync(path(second), "utf8")).toBe(before);
  });
  const retry: string[] = [];
  expect((await markManySupersededReport([first, second].map((ts) => ({ ts, fields: { superseded_by: "survivor", reason: "probe" } })), retry)).marked).toEqual([second]);
  expect(retry).toEqual([second]);
  expect(durable).toEqual([first]);
});

test("refusal at the first file has no durable receipts and merge reports no mutation", async () => {
  seed(first, "loser row"); seed(second, "survivor row");
  const p = await plugin();
  const before = [readFileSync(path(first), "utf8"), readFileSync(path(second), "utf8")];
  const durable: string[] = [];
  await held(path(first), async () => {
    await expect(markManySupersededReport([{ ts: first, fields: { superseded_by: second, reason: "probe" } }], durable)).rejects.toThrow(/busy/);
    expect(durable).toEqual([]);
    const out = await p.tools.memory_merge_review.execute({ loser: first, survivor: second, reason: "chosen by human" }, ctx);
    expect(out.content).toContain("nothing was done");
    expect(out.content).not.toContain("PARTIAL");
    expect(out.content).toContain(basename(path(first)));
    expect([readFileSync(path(first), "utf8"), readFileSync(path(second), "utf8")]).toEqual(before);
  });
});

test("merge_review reports the retirement already published before a later timeout", async () => {
  seed(first, "loser row"); seed(second, "survivor row");
  const p = await plugin();
  await held(path(second), async () => {
    const out = await p.tools.memory_merge_review.execute({ loser: first, survivor: second, reason: "chosen by human" }, ctx);
    expect((await loadAll()).find((row) => row.ts === first)?.superseded_by).toBe(second);
    expect(out.content).toContain("PARTIAL");
    expect(out.content).toContain(first);
    expect(out.content).toContain(basename(path(second)));
    expect(out.content).not.toContain("nothing was done");
  });
});

test("canonical update retains the gate's completed retirement on a later busy file", async () => {
  seed(first, "worker backend mysql"); seed(second, "queue backend redis");
  writeFileSync(canonicalFile(), formatLine({ ts: first, type: "canonical", scope: "planning", entity: "backend", value: "postgres", source: "fixture" }) + "\n");
  const p = await plugin();
  await held(path(second), async () => {
    const out = await p.tools.memory_update.execute({ type: "context", scope: "planning", query: second, content: "queue backend postgres" }, ctx);
    expect((await loadAll()).find((row) => row.ts === first)?.superseded_by).toBeDefined();
    expect(out.content).not.toContain("Nothing was written");
    expect(out.content).toContain(first);
    expect(out.content).toContain(basename(path(second)));
    expect((await loadAll()).find((row) => row.ts === second)?.superseded_by).toBeUndefined();
  });
});

test("restore uses its real fail-closed policy and preserves the held file", async () => {
  seed(first, "snapshot row");
  const [snapshot] = await snapshotFiles([path(first)]);
  seed(first, "current row must survive refusal");
  const before = readFileSync(path(first), "utf8");
  await held(path(first), async () => {
    await expect(restoreSnapshot(snapshot, memoryRoot(), "force")).rejects.toThrow(/busy/);
    expect(readFileSync(path(first), "utf8")).toBe(before);
  });
  expect((await restoreSnapshot(snapshot, memoryRoot(), "force")).restored).toBe(true);
  expect((await loadAll())[0].content).toBe("snapshot row");
});

test("viewer edit names the durable replacement when retiring its original is refused", async () => {
  seed(first, "original viewer row");
  await held(path(first), async () => {
    let error = "";
    try { await editMemory({ ts: first, type: "context", scope: "planning", content: "edited viewer row", reason: "human correction" }); }
    catch (err) { error = String(err); }
    const rows = await loadAll();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.superseded_by)).toBe(true);
    const replacement = rows.find((row) => row.content === "edited viewer row");
    expect(replacement).toBeDefined();
    expect(error).toContain("PARTIAL");
    if (!replacement) throw new Error("viewer replacement missing");
    expect(error).toContain(replacement.ts);
    expect(error).toContain(first);
  });
});

test.each(["memory_forget", "memory_decay"])("%s reports and audits the rows published before a later timeout", async (tool) => {
  seed(first, "first planned task"); seed(second, "second planned task");
  const p = await plugin();
  await held(path(second), async () => {
    const args = tool === "memory_forget" ? { scope: "planning", type: "context", reason: "human cleanup" } : { days: 1, dryRun: false };
    const out = await p.tools[tool].execute(args, ctx);
    expect(out.content).toContain("PARTIAL");
    expect(out.content).toContain(first);
    expect(out.content).toContain(basename(path(second)));
    const evidence = readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8").split("\n").map(parseLine);
    const receipt = evidence.find((row) => row?.ev === (tool === "memory_forget" ? "prune" : "decay_applied"));
    expect(receipt?.partial).toBe("true");
    expect(receipt?.mem).toBe(first);
    const rows = await loadAll();
    expect(rows.find((row) => row.ts === second)?.superseded_by).toBeUndefined();
    if (tool === "memory_forget") expect(rows.map((row) => row.ts)).toEqual([second]);
    else expect(rows.find((row) => row.ts === first)?.superseded_by).toBe("decay");
  });
});

test("capture records each busy refusal and still records lag", async () => {
  const today = `${dateStr()}T00:00:00.000Z`;
  seed(today, "unrelated existing row");
  const p = await loadPlugin(root, { autoCapture: true, captureModel: "fake/model" });
  plugins.push(p);
  await p["tool.execute.after"]({ tool: "read", sessionID: "capture-busy", callID: "C1", args: { filePath: "x.ts" } }, { title: "read", output: "content", metadata: {} });
  p.capture.generate.response = JSON.stringify([
    { type: "learning", scope: "archive", content: "The nightly archive job runs at 02:30 UTC and keeps fourteen days of tarballs" },
    { type: "learning", scope: "build", content: "Run bun test from the repository root to execute the test suite" },
  ]);
  const before = readFileSync(path(today), "utf8");
  await held(path(today), async () => {
    await p.sessionHooks["compaction"]?.({ sessionID: "capture-busy", system: [], messages: [{ role: "user", content: "The nightly archive job runs at 02:30 UTC and keeps fourteen days of tarballs for restore drills. Run bun test from the repository root to execute the test suite. Keep both operational notes in the project runbook for future sessions and reviews." }] });
    const deadline = Date.now() + 3000;
    while (!readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8").includes("ev=capture_lag")) {
      if (Date.now() >= deadline) throw new Error("capture did not finish or record lag");
      await Bun.sleep(5);
    }
    const lines = readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8").split("\n").map(parseLine);
    const refused = lines.filter((row) => row?.ev === "auto_capture_refused");
    expect(refused).toHaveLength(2);
    expect(refused.map((row) => row?.scope).sort()).toEqual(["archive", "build"]);
    expect(refused.every((row) => String(row?.reason).includes("busy"))).toBe(true);
    expect(lines.filter((row) => row?.ev === "capture_lag")).toHaveLength(1);
    expect(readFileSync(path(today), "utf8")).toBe(before);
  });
});
