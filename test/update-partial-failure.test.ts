// Probe for #155: the memory_update twin of the merge_review partial-result
// fix (156e887). runWriteGate awaits its write_promoted audit AFTER the
// append, so when that audit throws, the replacement row IS on disk while the
// tool's catch — whose premise ("only the fail-closed lock timeout throws
// here") is false — declares "Nothing was written". The original stays
// active, the replacement stays un-superseded, and a retry reports
// "Duplicate ignored" while two active versions of the row exist.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { appendMemory } from "../src/store/files/append.ts"
import { loadAll } from "../src/store/files/load.ts";
import { resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import * as evidence from "../src/evidence/record.ts";

let root: string;
let a: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-uppart-"));
  a = join(root, "repo-a");
  mkdirSync(a);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  plugins = [];
});

afterEach(async () => {
  for (const p of plugins) await p.cleanup();
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("osi-uppart-")) {
    throw new Error("Unexpected fixture cleanup path");
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function plugin(dir: string | null) {
  const p = await loadPlugin(dir);
  plugins.push(p);
  return p;
}
async function seed(dir: string, content: string) {
  const scope = resolveRepo(dir);
  return appendMemory({
    type: "context",
    scope: "planning",
    content,
    status: "open",
    repo: scope.key,
    repoPath: scope.path,
  });
}
const ctx = (sessionID: string) => ({ sessionID, id: "uppart-proof" });

describe("memory_update reports post-append failures truthfully (#155)", () => {
  test("a post-append audit failure must not make update claim that nothing was written", async () => {
    const pa = await plugin(a);
    const original = await seed(a, "Plan to prune aged queue entries every evening");
    const record = evidence.record;
    const spy = spyOn(evidence, "record").mockImplementation(async (...args: Parameters<typeof record>) => {
      if (args[0] === "write_promoted") throw new Error("ENOSPC: injected evidence append failure");
      return record(...args);
    });
    let result: { content: string };
    try {
      result = await pa.tools.memory_update.execute(
        {
          type: "context",
          scope: "planning",
          query: original,
          content: "Plan to prune aged queue entries every morning",
          status: "open",
        },
        ctx("ses-a"),
      );
    } finally {
      spy.mockRestore();
    }
    expect(result.content).not.toContain("Nothing was written");
    // The replacement is durable; the fault path must not leave the store
    // sitting on two active versions of the row (acceptance: "make retry
    // finish or explicitly recover the incomplete update").
    const all = await loadAll();
    expect(all.some((m) => m.content.includes("every morning"))).toBe(true);
    expect(all.find((m) => m.ts === original)?.superseded_by).toBeDefined();
    const retry = await pa.tools.memory_update.execute(
      {
        type: "context",
        scope: "planning",
        query: original,
        content: "Plan to prune aged queue entries every morning",
        status: "open",
      },
      ctx("ses-a"),
    );
    // Re-running the SAME update after a completed partial must read as the
    // duplicate it is, not as a second write or a not-found dead end.
    expect(retry.content).toContain("Duplicate ignored");
    const active = (await loadAll()).filter((m) => !m.superseded_by);
    expect(active.some((m) => m.content.includes("every evening"))).toBe(false);
    expect(active.some((m) => m.content.includes("every morning"))).toBe(true);
  });

  test("control: a genuine pre-mutation failure still writes nothing and says so", async () => {
    const pa = await plugin(a);
    const original = await seed(a, "Watermark the nightly export with the HEAD sha");
    const result = await pa.tools.memory_update.execute(
      { type: "context", scope: "planning", query: "no-such-row-ts", content: "anything else entirely", status: "open" },
      ctx("ses-a"),
    );
    expect(result.content).toContain("Nothing was written");
    expect((await loadAll()).some((m) => m.content === "anything else entirely")).toBe(false);
    // The untouched original is still the single active row.
    expect((await loadAll()).find((m) => m.ts === original)?.superseded_by).toBeUndefined();
  });
});
