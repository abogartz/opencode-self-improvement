// #152 — the WRITE-side twin of #127/#133. A server-style plugin instance
// (setup with no `location`) cannot bind a fresh session when neither the
// context API nor the session row describes it. Reads already fail closed for
// that caller: `readerForSession` gives it `global-only`, never the module
// scope of whoever set up LAST. Writes did not: `appendMemory` stamped through
// `repoScopeFor()`, whose last resort IS the module scope — so an unresolved
// session in repo A wrote A's private content into repo B's rows (or, with no
// module scope at all, published it as a legacy/global row every later repo
// recalls). The rule this file pins: an identity that cannot read a repository
// cannot write one either. Refuse, loudly, and store nothing.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { appendMemory } from "../src/store/files/append.ts"
import { loadAll } from "../src/store/files/load.ts";
import { rememberSessionDir, resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { evidenceDir, exportsDir } from "../src/core/config/paths.ts"
import { dateStr } from "../src/core/time.ts";
import { parseLine, type Fields } from "../src/core/logfmt/format.ts";

// status:"open" is the planning-thread home: a settled claim would be blocked
// by GATE-4 for having no code refs, and the test would prove nothing about the
// write identity because nothing reached the stamp at all.
const CANDIDATE = {
  type: "context",
  scope: "planning",
  status: "open",
  content: "UNRESOLVED_A_PRIVATE_RELEASE_PLAN",
};

let root: string;
let a: string;
let b: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-152-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
  // ONE shared store for every instance: rows separate only by their stamp.
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
  resetCaptureCooldowns();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function load(directory: string | null, options?: Record<string, unknown>) {
  const p = await loadPlugin(directory, options);
  plugins.push(p);
  return p;
}

const ctx = (sessionID: string) => ({ sessionID, id: "call-152" });

const rowsWith = async (marker: string) =>
  (await loadAll()).filter((m) => m.content.includes(marker));

async function evidenceAsync(): Promise<Fields[]> {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  if (!(await Bun.file(file).exists())) return [];
  const text = await Bun.file(file).text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => parseLine(l))
    .filter((x): x is Fields => x !== null);
}

// --- the leak -----------------------------------------------------------------

// The reported sequence: A's plugin has no setup location, B's plugin loaded
// LAST (so the module scope is B's), A's session never resolves. B must not
// receive A's content through ordinary scoped recall — and A's write must not
// silently succeed somewhere.
test("an unresolved named session never writes into the LAST setup's repository", async () => {
  const pa = await load(null);
  const pb = await load(b);
  const res = await pa.tools.memory_remember.execute(CANDIDATE, ctx("ses-unresolved-a"));
  const row = (await loadAll()).find((m) => m.content === CANDIDATE.content);
  const seen = await pb.tools.memory_recall.execute({ query: CANDIDATE.content }, ctx("ses-b"));

  expect(row).toBeUndefined(); // nothing was stamped into B...
  expect(seen.content).not.toContain(CANDIDATE.content); // ...and B recalls nothing
  expect(res.content.toLowerCase()).toContain("refus");
  expect(res.content).not.toContain("Remembered");
});

// The other half: with no module scope at all, the fallback was "no stamp",
// which every reader treats as GLOBAL. An ownerless write must not become a
// cross-project publish either.
test("an unresolved named session cannot publish a global memory", async () => {
  const pa = await load(null);
  const res = await pa.tools.memory_remember.execute(CANDIDATE, ctx("ses-unresolved-a"));
  expect(res.content).not.toContain("Remembered");
  expect((await loadAll()).some((m) => m.content === CANDIDATE.content)).toBe(false);

  const pb = await load(b);
  const seen = await pb.tools.memory_recall.execute({ query: CANDIDATE.content }, ctx("ses-b"));
  expect(seen.content).not.toContain(CANDIDATE.content);
});

// memory_update writes a replacement row the same way, and its target may be a
// global row the unbound caller CAN read — so the replacement is where the
// content moves repositories.
test("an unresolved named session cannot re-stamp a row into another repository", async () => {
  const pa = await load(null);
  const pb = await load(b);
  const target = await appendMemory({
    type: "context",
    scope: "planning",
    content: "GLOBAL_ROW_BEFORE_UNRESOLVED_UPDATE",
    status: "open",
    repo: "global",
  });
  const res = await pa.tools.memory_update.execute(
    {
      scope: "planning",
      type: "context",
      content: "UNRESOLVED_A_PRIVATE_RELEASE_PLAN",
      status: "open",
      query: target,
    },
    ctx("ses-unresolved-a"),
  );
  expect(res.content.toLowerCase()).toContain("refus");
  expect((await loadAll()).some((m) => m.content === CANDIDATE.content)).toBe(false);
  const still = (await loadAll()).find((m) => m.ts === target);
  expect(still?.superseded_by).toBeUndefined(); // the global row is untouched
  expect((await pb.tools.memory_recall.execute({ query: CANDIDATE.content }, ctx("ses-b"))).content).not.toContain(
    CANDIDATE.content,
  );
});

// memory_import re-stamps every row it reads with the importing session's repo
// — the same fallback, applied to a whole file at once.
test("memory_import refuses an unresolved named session before writing anything", async () => {
  const pa = await load(null);
  const pb = await load(b);
  mkdirSync(exportsDir(), { recursive: true });
  const file = join(exportsDir(), "in-152.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({ _export: "opencode-self-improvement", version: 1 }),
      JSON.stringify({
        type: "learning",
        scope: "build",
        status: "open",
        content: "UNRESOLVED_IMPORT_ROW_ONE",
      }),
      JSON.stringify({
        type: "learning",
        scope: "build",
        status: "open",
        content: "UNRESOLVED_IMPORT_ROW_TWO",
      }),
    ].join("\n"),
  );
  const res = await pa.tools.memory_import.execute({ file: "in-152.jsonl" }, ctx("ses-unresolved-a"));
  expect(res.content.toLowerCase()).toContain("refus");
  expect((await loadAll()).length).toBe(0); // fail closed BEFORE the loop, not mid-file
  const seen = await pb.tools.memory_recall.execute({ query: "UNRESOLVED_IMPORT_ROW_ONE" }, ctx("ses-b"));
  expect(seen.content).not.toContain("UNRESOLVED_IMPORT_ROW_ONE");
});

// Auto-capture mines a whole transcript and writes through the same gate. With
// no resolvable owner it must not publish any of it — and it must say so in
// evidence rather than die inside the guarded hook.
test("auto-capture stores nothing for a session whose repository is unresolved", async () => {
  const p = await load(null, { autoCapture: true, captureModel: "fake/model" });
  p.capture.context.messages = [{ role: "user", content: "x".repeat(300) }];
  p.capture.generate.response = JSON.stringify([
    { type: "learning", scope: "build", status: "open", content: "UNRESOLVED_CAPTURE_ROW" },
  ]);
  const isRefusal = (l: Fields) =>
    l.ev === "auto_capture_refused" && l.sid === "ses-unresolved" &&
    l.session === "ses-unresolved" && l.trigger === "idle";
  p.capture.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses-unresolved" } });
  const lines = await (async () => {
    let ev: Fields[] = [];
    for (let i = 0; i < 200; i++) {
      ev = await evidenceAsync();
      // A prefix match is not completion: wait for the full refusal record
      // for this session before checking that capture stored nothing.
      if (ev.some(isRefusal)) return ev;
      await new Promise((r) => setTimeout(r, 10));
    }
    return ev;
  })();
  expect(await rowsWith("UNRESOLVED_CAPTURE_ROW")).toHaveLength(0);
  expect(lines, "expected a complete refusal record for ses-unresolved").toContainEqual(
    expect.objectContaining({
      ev: "auto_capture_refused", sid: "ses-unresolved", session: "ses-unresolved", trigger: "idle",
    }),
  );
  expect(p.capture.generate.calls).toHaveLength(0);
  await p.cleanup();
});

// --- what must keep working ---------------------------------------------------

// Fail-closed must not mean fail-wrong: a session bound from its own events
// keeps its ordinary private write.
test("control: a bound caller still stores private memory only for its own repo", async () => {
  const pa = await load(a);
  const pb = await load(b);
  rememberSessionDir("ses-a", a);
  const res = await pa.tools.memory_remember.execute(CANDIDATE, ctx("ses-a"));
  expect(res.content).toContain("Remembered");
  const row = (await loadAll()).find((m) => m.content === CANDIDATE.content);
  expect(row?.repo).toBe(resolveRepo(a).key);
  expect((await pa.tools.memory_recall.execute({ query: CANDIDATE.content }, ctx("ses-a"))).content).toContain(
    CANDIDATE.content,
  );
  expect((await pb.tools.memory_recall.execute({ query: CANDIDATE.content }, ctx("ses-b"))).content).not.toContain(
    CANDIDATE.content,
  );
});

// A plugin instance that DOES know its workspace keeps resolving an unknown
// session to that workspace (the provisional binding #127 introduced): one
// project per instance is the ordinary shape and must stay frictionless.
test("a session-unknown call into a workspace-bound instance still writes there", async () => {
  const pa = await load(a);
  const res = await pa.tools.memory_remember.execute(CANDIDATE, ctx("ses-never-seen"));
  expect(res.content).toContain("Remembered");
  const row = (await loadAll()).find((m) => m.content === CANDIDATE.content);
  expect(row?.repo).toBe(resolveRepo(a).key);
});

// The two deliberate escapes stay exactly as documented.
test("explicit global:true from an unresolved session is still a global row", async () => {
  const pa = await load(null);
  const res = await pa.tools.memory_remember.execute({ ...CANDIDATE, global: true }, ctx("ses-unresolved-a"));
  expect(res.content).toContain("Remembered");
  const row = (await loadAll()).find((m) => m.content === CANDIDATE.content);
  expect(row?.repo).toBe("global");
  const pb = await load(b);
  expect((await pb.tools.memory_recall.execute({ query: CANDIDATE.content }, ctx("ses-b"))).content).toContain(
    CANDIDATE.content,
  );
});

// The sessionless admin path (viewer process, scripts, restore): no named
// session at all, so the module scope is the answer, as it always was.
test("a sessionless writer keeps stamping the module scope", async () => {
  const pa = await load(a);
  const res = await pa.tools.memory_remember.execute(CANDIDATE, {});
  expect(res.content).toContain("Remembered");
  const row = (await loadAll()).find((m) => m.content === CANDIDATE.content);
  expect(row?.repo).toBe(resolveRepo(a).key);
});

// The refusal is the only thing a model sees, so it has to carry the fix.
test("the refusal names the reason and the two ways out", async () => {
  const pa = await load(null);
  const res = await pa.tools.memory_remember.execute(CANDIDATE, ctx("ses-unresolved-a"));
  expect(res.content).toContain("repository");
  expect(res.content).toContain("global:true");
  expect((await evidenceAsync()).some((l) => l.ev === "write_refused" && l.sid === "ses-unresolved-a")).toBe(
    true,
  );
});
