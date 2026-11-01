// Hook-level lifecycle contracts for the #168 extraction. These also pass
// with the policy inline: this is a refactor, not a new cache policy.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { appendMemory } from "../src/store/files/append.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { SESSION_CAP } from "../src/core/lru.ts";
import { resetState } from "../src/core/state.ts";
import { readStatus } from "../src/status/write.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";

let root: string, repo: string, plugins: LoadedPlugin[];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "osi-epoch-lifecycle-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState(); resetSessionScopes(); setRepoScope(null);
  plugins = [];
  await appendMemory({ type: "pattern", scope: "alpha", content: "azuki build workflow", repo: "global" });
  await appendMemory({ type: "pattern", scope: "beta", content: "koto deploy workflow", repo: "global" });
});
afterEach(async () => {
  for (const p of plugins) await p.cleanup();
  resetState(); resetSessionScopes(); setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR; delete process.env.OPENCODE_COMMANDS_DIR;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("osi-epoch-lifecycle-")) {
    throw new Error("Unexpected fixture cleanup target");
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
async function plugin() {
  const p = await loadPlugin(repo); plugins.push(p); return p;
}
async function context(p: LoadedPlugin, sid: string): Promise<string[]> {
  const event = { sessionID: sid, system: [] as { type: string; text: string }[] };
  await p.sessionHooks.context(event);
  return event.system.map(part => part.text);
}
const prompt = (p: LoadedPlugin, sid: string, text = "azuki") => p.sessionHooks.prompt({ sessionID: sid, prompt: { text } });
const report = async (p: LoadedPlugin, sid: string) => (await p.tools.memory_status.execute({}, { sessionID: sid, id: "status" })).content;
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for the host event listener");
}

test("context before a prompt and after compaction stays uncached; compaction keeps lifetime counters", async () => {
  const p = await plugin(), sid = "ses-lifecycle";
  const first = (await context(p, sid)).join("\n");
  expect(first).toContain("## Persistent memory");
  expect(first).not.toContain("## Relevant durable memory");
  expect(await report(p, sid)).toContain("no epoch yet");

  await prompt(p, sid);
  expect((await context(p, sid)).join("\n")).toContain("azuki");
  expect(await report(p, sid)).toContain("2 request(s)");

  await p.sessionHooks.compaction({ sessionID: sid, system: [] });
  expect((await context(p, sid)).join("\n")).not.toContain("## Relevant durable memory");
  expect(await report(p, sid)).toContain("no epoch yet");

  await prompt(p, sid, "koto");
  const resumed = await readStatus(sid);
  expect(resumed?.reason).toBe("first");
  expect(resumed?.stats?.requests).toBe(3);
  expect(resumed?.stats?.epochRequests).toBe(0);
  expect(resumed?.stats?.invalidations).toBe(0);
  expect((await context(p, sid)).join("\n")).toContain("koto");
  expect(await report(p, sid)).toContain("4 request(s)");
});

test("separate setup instances retain independent frozen bytes for the same session", async () => {
  const a = await plugin(), b = await plugin(), sid = "ses-two-setups";
  await prompt(a, sid, "azuki");
  const first = await context(a, sid);
  await prompt(b, sid, "koto");
  const second = await context(b, sid);
  expect(first.join("\n")).toContain("azuki");
  expect(second.join("\n")).toContain("koto");
  expect(second).not.toEqual(first);
  expect(await context(a, sid)).toEqual(first);
  expect(await report(a, sid)).toContain("2 request(s)");
  expect(await report(b, sid)).toContain("1 request(s)");
});

test("usage-only sessions evict prompt, epoch, counters, and measured usage together", async () => {
  const p = await plugin(), sid = "ses-usage-eviction";
  await prompt(p, sid);
  const first = await context(p, sid);
  p.capture.events.push({ type: "session.usage.updated", data: { sessionID: sid, tokens: { input: 7, cache: { read: 13 } } } });
  await until(async () => (await readStatus(sid))?.measured?.read === 13);

  for (let i = 0; i < SESSION_CAP; i++) {
    p.capture.events.push({ type: "session.usage.updated", data: { sessionID: `usage-only-${i}`, tokens: { input: 1 } } });
  }
  // This identity event is consumed after all queued usage events; the fake
  // API call is an observable barrier without guessing a processing delay.
  p.capture.events.push({ type: "session.execution.started", data: { sessionID: "usage-barrier" } });
  await until(() => p.capture.session.getCalls.includes("usage-barrier"));
  expect(await report(p, sid)).toContain("no epoch yet");

  await prompt(p, sid);
  const resumed = await readStatus(sid);
  expect(resumed?.reason).toBe("first");
  expect(resumed?.stats?.requests).toBe(0);
  expect(resumed?.stats?.invalidations).toBe(0);
  expect(resumed?.measured).toBeNull();
  expect(await context(p, sid)).toEqual(first);
});
