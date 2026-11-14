// #268 F1: the catch-all block hint must name a memory_evidence filter that
// actually returns the blocked row. `ev` matches the EVENT type
// (`write_blocked`), never the block reason — a session that filters by the
// reason it was just told gets "No evidence" while the row sits in the log.
// The test parses the filter literally out of the tool's own output text and
// replays it, so the hint can never drift from the evidence schema again.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
let loaded: LoadedPlugin;
let oldMemory: string | undefined;
let oldCommands: string | undefined;

beforeEach(async () => {
  oldMemory = process.env.OPENCODE_MEMORY_DIR;
  oldCommands = process.env.OPENCODE_COMMANDS_DIR;
  root = mkdtempSync(join(tmpdir(), "osi-hint-filter-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  const repo = join(root, "repo");
  mkdirSync(repo);
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  loaded = await loadPlugin(repo, { autoCapture: false });
});

afterEach(async () => {
  await loaded?.cleanup();
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  if (oldMemory === undefined) delete process.env.OPENCODE_MEMORY_DIR;
  else process.env.OPENCODE_MEMORY_DIR = oldMemory;
  if (oldCommands === undefined) delete process.env.OPENCODE_COMMANDS_DIR;
  else process.env.OPENCODE_COMMANDS_DIR = oldCommands;
  removeStore(root);
});

test("a blocked write's hint names a memory_evidence filter that returns the blocked row", async () => {
  const sid = "hint-filter";
  const ctx = { sessionID: sid, callID: "write-ambiguous" };
  // Empty scope, no embedded refs, no engagement, no planning words: the
  // gate blocks ambiguous_memory with no block-specific hint, so the
  // catch-all text is what the session sees.
  const blocked = await loaded.tools.memory_remember.execute(
    {
      type: "learning",
      scope: "",
      content: "The worker drains the queue before shutdown.",
    },
    ctx,
  );
  expect(blocked.content).toContain("Write blocked at GATE (ambiguous_memory)");

  // Parse the filter literally from the output text — this is the step the
  // old text failed by construction: it named no `ev` value at all.
  const m = /\bmemory_evidence\b[^\n]*?\bev=([A-Za-z_]+)/.exec(blocked.content);
  expect(m).not.toBeNull();

  const replay = await loaded.tools.memory_evidence.execute({ ev: m![1] }, ctx);
  expect(replay.content).not.toBe("No evidence");
  expect(replay.content).toContain("ev=write_blocked");
  expect(replay.content).toContain("reason=ambiguous_memory");
});
