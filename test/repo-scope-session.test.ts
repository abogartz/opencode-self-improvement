// Contract: per-session repo identity. A server process can host sessions
// from several workspaces, and setup() can run before the host attaches a
// session location. Proves: repoScopeFor precedence (session > module,
// unknown/"?" sid -> module), dir-resolution caching, bounded session map,
// appendMemory stamps the WRITING session's repo, visibility follows the
// READING session, and the server-start window (no ctx.location) WRITES
// NOTHING for a session whose repository is still unresolved — neither the
// process cwd nor an unstamped "global" row (#152) — until a session event
// binds the identity.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberSessionDir, repoScopeFor, resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { appendMemory } from "../src/store/files/append.ts"
import { loadAll } from "../src/store/files/load.ts"
import { isVisibleHere } from "../src/store/model/visibility.ts";
import { resetState, setCurrent } from "../src/core/state.ts";
import { loadPlugin } from "./harness.ts";

const MODULE_SCOPE = { key: "mod111", path: "/work/module" };

// Non-git dirs key by hash of the normalized path (#92) — what the session
// machinery resolves a plain dir to, independent of this PR's hashing choice.
const keyOf = (d: string) => resolveRepo(d).key;

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
    expect(repoScopeFor("s1")).toEqual({ key: keyOf(a), path: a });
    rememberSessionDir("s1", b);
    expect(repoScopeFor("s1")).toEqual({ key: keyOf(b), path: b });
  });

  test("two sessions in one dir share one resolution", () => {
    const a = join(root, "shared");
    mkdirSync(a, { recursive: true });
    rememberSessionDir("s1", a);
    rememberSessionDir("s2", a);
    expect(repoScopeFor("s1")).toBe(repoScopeFor("s2"));
  });

  // 70 real mkdirs: under Windows Defender timing on CI runners this leg
  // measurably exceeds the 5s default (observed 5.2-5.3s, killed after the
  // dangling process) - that is AV load, not a hang, and the family is a
  // known pre-existing flake. One wider timeout for the one heavy test;
  // every other test in this file keeps the default.
  test(
    "the session map is bounded; the oldest entry falls back",
    () => {
      const dirs: string[] = [];
      for (let i = 0; i < 70; i++) {
        const d = join(root, `r${i}`);
        mkdirSync(d, { recursive: true });
        dirs.push(d);
        rememberSessionDir(`s${i}`, d);
      }
      expect(repoScopeFor("s0")).toBe(MODULE_SCOPE); // evicted
      expect(repoScopeFor("s69")).toEqual({ key: keyOf(dirs[69]), path: dirs[69] });
    },
    20_000,
  );
});

describe("stamping follows the writing session", () => {
  test("appendMemory stamps the session repo, not the module repo", async () => {
    const a = join(root, "repoA");
    mkdirSync(a, { recursive: true });
    rememberSessionDir("s1", a);
    setCurrent({ sessionID: "s1", callID: "c1", tool: "memory_remember" });
    await appendMemory({ type: "learning", scope: "s", content: "written by session one in repo A" });
    const raw = readFileSync(dayFile(), "utf8");
    expect(raw).toContain(`repo=${keyOf(a)}`);
    expect(raw).toContain(`repoPath=${a}`);
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
  test("an early write from an unresolved session is refused, and an execution.started event binds later writes", async () => {
    const loaded = await loadPlugin(null);
    try {
      // Window write: the host named session sW, but nothing has resolved a
      // repository for it. Stamping nothing used to mean "global" — a private
      // fact published to every project that ever opens this store (#152). An
      // ownerless write is refused now, so the day file stays untouched.
      await loaded["tool.execute.before"]({ sessionID: "sW", callID: "c1", tool: "read" });
      await loaded["tool.execute.after"](
        { sessionID: "sW", callID: "c1", tool: "read", args: { filePath: "x.ts" } },
        { output: "content", metadata: {} },
      );
      const early = await loaded.tools["memory_remember"].execute(
        { type: "learning", scope: "win", content: `window fact ${Date.now()} about early writes` },
        {},
      );
      expect(early.content).toContain("Write refused");
      expect(existsSync(dayFile())).toBe(false);

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
      const raw = readFileSync(dayFile(), "utf8");
      expect(raw).toContain(`repo=${keyOf(repo)}`);
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
      expect(raw).toContain(`repo=${keyOf(sessionWs)}`);
      expect(raw).not.toContain(moduleDir);
    } finally {
      await loaded.cleanup();
    }
  });
});
