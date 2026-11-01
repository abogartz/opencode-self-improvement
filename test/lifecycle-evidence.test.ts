import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dateStr, evidenceDir } from "../src/config.ts";
import { parseLine } from "../src/logfmt.ts";
import { runInit } from "../src/init.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import * as gates from "../src/gates.ts";
import { captureEvidenceContext, record } from "../src/evidence.ts";
import { rememberSessionDir, resetSessionScopes, resolveRepo, setRepoScope } from "../src/repokey.ts";
import { resetState, setCurrent } from "../src/state.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";

let root: string, a: string, b: string;
let plugins: LoadedPlugin[];
let saved: Record<string, string | undefined>;
let undoSpy = () => {};
const keys = ["OPENCODE_MEMORY_DIR", "OPENCODE_COMMANDS_DIR", "OPENCODE_CBM_BIN"];
// The lifecycle hooks await plugin cleanup and the capture tests poll for
// fire-and-forget evidence; on a busy Windows runner these pass the default
// 5s budget with real work (green run: 8s on the capture test's hook).
// 30s budgets across hooks and tests; assertions unchanged (#245).
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "osi-lifecycle-evidence-"));
  a = join(root, "a"); b = join(root, "b"); mkdirSync(a); mkdirSync(b);
  writeFileSync(join(a, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  process.env.OPENCODE_CBM_BIN = join(root, "missing-cbm");
  resetState(); resetSessionScopes(); resetCaptureCooldowns(); setRepoScope(null); plugins = [];
}, 30_000);
afterEach(async () => {
  undoSpy(); undoSpy = () => {};
  for (const p of plugins) await p.cleanup();
  resetState(); resetSessionScopes(); resetCaptureCooldowns(); setRepoScope(null);
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}, 30_000);
async function plugin(dir: string, capture = false) {
  const p = await loadPlugin(dir, capture ? { autoCapture: true, captureModel: "fake/model" } : {});
  plugins.push(p); return p;
}
function events() {
  try { return readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8").trim().split("\n").map(parseLine).filter((row) => row !== null); }
  catch { return []; }
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() > deadline) throw new Error("lifecycle did not complete"); await Bun.sleep(5); }
}
const read = async (p: LoadedPlugin, sid: string, ev: string) => (await p.tools.memory_evidence.execute({ ev }, { sessionID: sid, id: "read" })).content;

test.each(["resolved", "unresolved", "ambient"])("init lifecycle retains its %s entry owner across a move", async (kind) => {
  const pa = await plugin(a), pb = await plugin(b);
  const sid = kind === "ambient" ? undefined : "owner";
  if (kind === "resolved") rememberSessionDir("owner", a);
  setRepoScope(resolveRepo(a));
  setCurrent({ sessionID: sid ?? "?", callID: "entry-call" });
  const pending = runInit({ liveRoot: a, sessionID: sid });
  // runInit has captured its context and is suspended at its first await.
  rememberSessionDir("owner", b); setRepoScope(resolveRepo(b));
  setCurrent({ sessionID: "other", callID: "foreign-call" });
  if (kind === "unresolved") await expect(pending).rejects.toThrow("no resolvable repository");
  else await pending;
  for (const ev of kind === "unresolved" ? ["init_start"] : ["init_start", "init_complete"]) {
    const lines = events().filter((row) => row.ev === ev);
    expect(lines).toHaveLength(1);
    expect(lines[0].call).toBeUndefined();
    if (kind === "unresolved") {
      expect(lines[0].repo).toBeUndefined(); expect(lines[0].sid).toBe("owner");
      expect(await read(pa, "owner", ev)).toContain(`ev=${ev}`);
    } else {
      expect(lines[0].repo).toBe(resolveRepo(a).key); expect(lines[0].sid).toBeUndefined();
      expect(await read(pa, "reader-a", ev)).toContain(`ev=${ev}`);
    }
    expect(await read(pb, "reader-b", ev)).toBe("No evidence");
  }
  if (kind === "resolved") {
    rememberSessionDir("owner", a); setCurrent({ sessionID: "owner" });
    const again = runInit({ liveRoot: a, sessionID: "owner" });
    rememberSessionDir("owner", b); setCurrent({ sessionID: "other" });
    expect((await again).skipped).toBe(true);
    expect(await read(pa, "reader-a", "init_skip")).toContain("ev=init_skip");
    expect(await read(pb, "reader-b", "init_skip")).toBe("No evidence");
  }
}, 30_000);

test.each(["promoted", "refused"])("capture %s and lag remain with the pre-model operation", async (verdict) => {
  const pa = await plugin(a, true), pb = await plugin(b);
  rememberSessionDir("owner", a);
  await pa["tool.execute.after"]({ tool: "read", sessionID: "owner", callID: "ground", args: { filePath: "x.ts" } }, { title: "read", output: "content", metadata: {} });
  let release = () => {};
  pa.capture.generate.park = new Promise<void>((resolve) => { release = resolve; });
  pa.capture.generate.response = JSON.stringify([{ type: "pattern", scope: "deploy", content: "The staging API permits 120 requests per minute per key for batch importers." }]);
  const messages = [{ role: "user", content: "Discuss the staging API batch import rate limit and remember the per-key limit for deployment. ".repeat(5) }];
  await pa.sessionHooks.compaction({ sessionID: "owner", system: [], messages });
  try {
    await waitFor(() => pa.capture.generate.calls.length === 1);
    rememberSessionDir("owner", b); setCurrent({ sessionID: "other", callID: "foreign-call" });
    if (verdict === "refused") {
      const spy = spyOn(gates, "runWriteGate").mockImplementation(async () => { throw new Error("synthetic refused write"); });
      undoSpy = () => spy.mockRestore();
    }
  } finally { release(); }
  await waitFor(() => events().some((row) => row.ev === "capture_lag"));
  const ev = verdict === "promoted" ? "auto_capture_compaction_promoted" : "auto_capture_refused";
  for (const name of [ev, "capture_lag"]) {
    const lines = events().filter((row) => row.ev === name);
    expect(lines).toHaveLength(1); expect(lines[0].repo).toBe(resolveRepo(a).key);
    expect(lines[0].sid).toBeUndefined(); expect(lines[0].call).toBeUndefined();
    expect(await read(pa, "reader-a", name)).toContain(`ev=${name}`);
    expect(await read(pb, "reader-b", name)).toBe("No evidence");
  }
}, 30_000);

test("suppressed captured unresolved evidence keeps its privacy label and scrubs prose", async () => {
  const pa = await plugin(a), pb = await plugin(b);
  setCurrent({ sessionID: "other", callID: "foreign-call" });
  const context = captureEvidenceContext("unknown");
  rememberSessionDir("unknown", b);
  const secret = "sk-proj-AbCdEf1234567890AbCdEf1234567890abcdef";
  await record("private_lifecycle", { reason: secret }, false, "unknown", context);
  const own = await read(pa, "unknown", "private_lifecycle");
  expect(own).toContain("sid=unknown"); expect(own).not.toContain(secret);
  expect(own).not.toContain("call="); expect(own).not.toContain("repo=");
  expect(await read(pb, "reader-b", "private_lifecycle")).toBe("No evidence");
}, 30_000);
