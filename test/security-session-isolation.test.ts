// Contract (#127): a flow's caller identity is an immutable Reader resolved
// at flow entry, NEVER the ambient global re-read after an await. Two sessions
// sharing one process must not receive each other's repository-private rows in
// system-prompt injection — the context hook suspends on the store read, and a
// concurrent session's hook may move the ambient current mid-flight. And an
// unbound plugin session fails CLOSED: explicit/legacy global rows only, never
// "every repository" (the old `!cur -> true` fail-open).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { appendMemory } from "../src/store/files/append.ts";
import {
  rememberSessionDir,
  resetSessionScopes,
  resolveRepo,
  setRepoScope,
} from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { resetCaptureCooldowns } from "../src/index.ts";

let root: string;
let a: string;
let b: string;
let plugin: LoadedPlugin | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-sec127-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  resetCaptureCooldowns();
  setRepoScope(null);
});

afterEach(async () => {
  await plugin?.cleanup();
  plugin = undefined;
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

test("a concurrent session dispatching mid-read cannot move this session's injection scope", async () => {
  plugin = await loadPlugin(a);
  rememberSessionDir("ses-a", a);
  rememberSessionDir("ses-b", b);
  await seedPrivate(a, "A_PRIVATE_FRONTIER");
  await seedPrivate(b, "B_PRIVATE_FRONTIER");

  // Both are real registered hooks. A's context hook parks on the store read;
  // B's before-tool hook dispatches while A is suspended and moves the global
  // current. A must still filter with the Reader resolved from ITS OWN sid
  // before the await (#127).
  const eventA: ContextEvent = { sessionID: "ses-a", system: [] };
  const pendingA = plugin.sessionHooks.context(eventA);
  await plugin.toolHooks["execute.before"]({ sessionID: "ses-b", callID: "b1", tool: "read" });
  await pendingA;
  const intoA = injected(eventA.system);
  expect(intoA).toContain("A_PRIVATE_FRONTIER");
  expect(intoA).not.toContain("B_PRIVATE_FRONTIER");

  // Both directions: the same interleaving against B's flow.
  const eventB: ContextEvent = { sessionID: "ses-b", system: [] };
  const pendingB = plugin.sessionHooks.context(eventB);
  await plugin.toolHooks["execute.before"]({ sessionID: "ses-a", callID: "a1", tool: "read" });
  await pendingB;
  const intoB = injected(eventB.system);
  expect(intoB).toContain("B_PRIVATE_FRONTIER");
  expect(intoB).not.toContain("A_PRIVATE_FRONTIER");
});

test("an unbound plugin session sees global rows only, never another repository's private rows", async () => {
  // No ctx.location: the server-start shape. The module scope stays null and
  // ses-unbound never appears in the session map — the caller identity names
  // NO repository, which is global-only, not "everything".
  plugin = await loadPlugin(null);
  const scopeB = resolveRepo(b);
  await appendMemory({
    type: "context",
    scope: "customer",
    content: "B_PRIVATE_UNBOUND_ROW",
    status: "open",
    repo: scopeB.key,
    repoPath: scopeB.path,
  });
  await appendMemory({
    type: "context",
    scope: "general",
    content: "EXPLICIT_GLOBAL_ROW",
    status: "open",
    repo: "global",
  });

  const event: ContextEvent = { sessionID: "ses-unbound", system: [] };
  await plugin.sessionHooks.context(event);
  const text = injected(event.system);
  expect(text).not.toContain("B_PRIVATE_UNBOUND_ROW");
  expect(text).toContain("EXPLICIT_GLOBAL_ROW");
});

test("the ordinary single-session flow still injects its own repo's rows", async () => {
  // Fail-CLOSED must not mean fail-SILENT: one session, no interleaving, the
  // normal path keeps working.
  plugin = await loadPlugin(b);
  rememberSessionDir("ses-b", b);
  await seedPrivate(b, "B_OWN_REPO_ROW");
  const event: ContextEvent = { sessionID: "ses-b", system: [] };
  await plugin.sessionHooks.context(event);
  expect(injected(event.system)).toContain("B_OWN_REPO_ROW");
});
