// Contract: per-session repo identity. A server process can host sessions
// from several workspaces, and setup() can run before the host attaches a
// session location. Proves: repoScopeFor precedence (session > module,
// unknown/"?" sid -> module), dir-resolution caching, bounded session map,
// appendMemory stamps the WRITING session's repo, visibility follows the
// READING session, and the server-start window (no ctx.location) stamps
// nothing at all until a session event binds the identity — never the
// process cwd.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberSessionDir, repoScopeFor, resetSessionScopes, setRepoScope } from "../src/repokey.ts";
import { appendMemory, isVisibleHere, loadAll } from "../src/memory.ts";
import { resetState, setCurrent } from "../src/state.ts";
import { loadPlugin } from "./harness.ts";

const MODULE_SCOPE = { key: "mod111", path: "/work/module" };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-reposess-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  setRepoScope(MODULE_SCOPE);
  resetSessionScopes();
  resetState();
});
afterEach(() => {
  setRepoScope(null);
  resetSessionScopes();
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const dayFile = () => join(process.env.OPENCODE_MEMORY_DIR!, `${new Date().toISOString().split("T")[0]}.logfmt`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

describe("repoScopeFor precedence", () => {
  test("unknown and '?' sids fall back to the module scope", () => {
    expect(repoScopeFor(undefined)).toBe(MODULE_SCOPE);
    expect(repoScopeFor("?")).toBe(MODULE_SCOPE);
    expect(repoScopeFor("nope")).toBe(MODULE_SCOPE);
  });

  test("a remembered session dir wins; a move replaces it", () => {
    const a = join(root, "repoA");
    const b = join(root, "repoB");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    rememberSessionDir("s1", a);
    expect(repoScopeFor("s1")).toEqual({ key: a, path: a });
    rememberSessionDir("s1", b);
    expect(repoScopeFor("s1")).toEqual({ key: b, path: b });
  });

  test("two sessions in one dir share one resolution", () => {
    const a = join(root, "shared");
    mkdirSync(a, { recursive: true });
    rememberSessionDir("s1", a);
    rememberSessionDir("s2", a);
    expect(repoScopeFor("s1")).toBe(repoScopeFor("s2"));
  });

  test("the session map is bounded; the oldest entry falls back", () => {
    const dirs: string[] = [];
    for (let i = 0; i < 70; i++) {
      const d = join(root, `r${i}`);
      mkdirSync(d, { recursive: true });
      dirs.push(d);
      rememberSessionDir(`s${i}`, d);
    }
    expect(repoScopeFor("s0")).toBe(MODULE_SCOPE); // evicted
    expect(repoScopeFor("s69")).toEqual({ key: dirs[69], path: dirs[69] });
  });
});

describe("stamping follows the writing session", () => {
  test("appendMemory stamps the session repo, not the module repo", async () => {
    const a = join(root, "repoA");
    mkdirSync(a, { recursive: true });
    rememberSessionDir("s1", a);
    setCurrent({ sessionID: "s1", callID: "c1", tool: "memory_remember" });
    await appendMemory({ type: "learning", scope: "s", content: "written by session one in repo A" });
    const raw = readFileSync(dayFile(), "utf8");
    expect(raw).toContain(`repo=${a}`);
    expect(raw).not.toContain(MODULE_SCOPE.key);
  });

  test("visibility: a session-A row is invisible to a session-B reader", async () => {
    const a = join(root, "repoA");
    const b = join(root, "repoB");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    rememberSessionDir("sA", a);
    rememberSessionDir("sB", b);
    setCurrent({ sessionID: "sA", callID: "c1", tool: "memory_remember" });
    await appendMemory({ type: "learning", scope: "s", content: "alpha session fact here" });

    setCurrent({ sessionID: "sA", callID: "c2", tool: "memory_recall" });
    expect((await loadAll()).filter(isVisibleHere).length).toBe(1);
    setCurrent({ sessionID: "sB", callID: "c3", tool: "memory_recall" });
    expect((await loadAll()).filter(isVisibleHere).length).toBe(0);
  });
});

describe("server-start window: setup with no location", () => {
  test("early writes stamp nothing (global), and an execution.started event binds later writes", async () => {
    const loaded = await loadPlugin(null);
    try {
      // Window write: no session identity known yet -> unscoped (global),
      // never a cwd-derived repo stamp.
      await loaded["tool.execute.before"]({ sessionID: "sW", callID: "c1", tool: "read" });
      await loaded["tool.execute.after"](
        { sessionID: "sW", callID: "c1", tool: "read", args: { filePath: "x.ts" } },
        { output: "content", metadata: {} },
      );
      await loaded.tools["memory_remember"].execute(
        { type: "learning", scope: "win", content: `window fact ${Date.now()} about early writes` },
        {},
      );
      let raw = readFileSync(dayFile(), "utf8");
      expect(raw).not.toContain("repo=");

      // First turn of another session: execution.started carries the location.
      const repo = join(root, "sessionRepo");
      mkdirSync(repo, { recursive: true });
      loaded.capture.events.push({
        type: "session.execution.started",
        data: { sessionID: "sX" },
        location: { directory: repo },
      });
      await waitFor(() => repoScopeFor("sX") !== null);

      await loaded["tool.execute.before"]({ sessionID: "sX", callID: "c2", tool: "read" });
      await loaded["tool.execute.after"](
        { sessionID: "sX", callID: "c2", tool: "read", args: { filePath: "y.ts" } },
        { output: "content", metadata: {} },
      );
      const out = await loaded.tools["memory_remember"].execute(
        { type: "learning", scope: "win", content: `bound fact ${Date.now()} about session-scoped writes` },
        {},
      );
      expect(out.content).toContain("Remembered");
      raw = readFileSync(dayFile(), "utf8");
      expect(raw).toContain(`repo=${repo}`);
    } finally {
      await loaded.cleanup();
    }
  });
});

describe("first-turn event-race backstop", () => {
  test("an unmapped session binds identity from session.context messages before its first write", async () => {
    const moduleDir = join(root, "serverWorkspace");
    const sessionWs = join(root, "sessionWorkspace");
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(sessionWs, { recursive: true });
    const loaded = await loadPlugin(moduleDir);
    try {
      loaded.capture.context.messages = [
        { info: { role: "user" }, location: { directory: sessionWs }, parts: [{ text: "hi" }] },
      ];
      await loaded["tool.execute.before"]({ sessionID: "sL", callID: "c1", tool: "read" });
      await loaded["tool.execute.after"](
        { sessionID: "sL", callID: "c1", tool: "read", args: { filePath: "x.ts" } },
        { output: "content", metadata: {} },
      );
      const out = await loaded.tools["memory_remember"].execute(
        { type: "learning", scope: "lazy", content: `lazy bind fact ${Date.now()} from message location` },
        {},
      );
      expect(out.content).toContain("Remembered");
      const raw = readFileSync(dayFile(), "utf8");
      expect(raw).toContain(`repo=${sessionWs}`);
      expect(raw).not.toContain(moduleDir);
    } finally {
      await loaded.cleanup();
    }
  });
});
