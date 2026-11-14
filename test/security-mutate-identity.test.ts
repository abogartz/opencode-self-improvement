// #260: the mutating tools that resolve their Reader — memory_merge_review,
// memory_forget, memory_undo — must await `bindSessionIdentity` BEFORE
// authorizing, the way memory_remember/update/import/init already do. An
// unseen session is otherwise bound provisionally to the INSTANCE's directory
// by the entry binding alone, so on a serve host (where the session row is the
// only source of truth and no prompt hook has run yet) authorization resolves
// against the wrong repository: the very boundary #131/#204 protect.
// Replay shape is the recorded serve-host one (see repo-scope-serve-host):
// context messages carry no location; the session ROW carries directory.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { loadAll } from "../src/store/files/load.ts";
import { snapshotFiles } from "../src/store/files/snapshots.ts";
import { resetState } from "../src/core/state.ts";
import {
  resetSessionScopes,
  resolveRepo,
  setRepoScope,
} from "../src/identity/repokey.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
let a: string; // where the plugin instance loads (serve launch dir)
let b: string; // the session's REAL workspace, per the host's session row
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-mutid-"));
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
  removeStore(root);
});

// Load the plugin in A and declare, via the session row the host would hand
// back, that `sid`'s workspace is B. No prompt hook, no execution.started:
// the tool call is the FIRST thing the instance sees for this session.
async function serveHostSessionInB(sid: string): Promise<LoadedPlugin> {
  const p = await loadPlugin(a);
  plugins.push(p);
  p.capture.context.messages = [
    {
      id: "msg_user0001",
      time: { created: 1792879840340 },
      text: "hello",
      type: "user",
    },
  ]; // recorded serve shape: no location on any row
  p.capture.session.row = { id: sid, location: { directory: b } };
  return p;
}

async function seedA(content: string) {
  const scope = resolveRepo(a);
  return appendMemory({
    type: "context",
    scope: "planning",
    content,
    status: "open",
    repo: scope.key,
    repoPath: scope.path,
  });
}

const tsOf = async (marker: string): Promise<string> =>
  (await loadAll()).find((m) => m.content.includes(marker))!.ts;

test("merge_review resolves session identity before authorizing (#260)", async () => {
  const sid = "ses-260-merge";
  const p = await serveHostSessionInB(sid);
  await seedA("A260_MERGE_WINNER");
  await seedA("A260_MERGE_LOSER");
  const loser = await tsOf("A260_MERGE_LOSER");

  const res = await p.tools.memory_merge_review.execute(
    {
      loser,
      survivor: await tsOf("A260_MERGE_WINNER"),
      reason: "cross-repo probe",
    },
    { sessionID: sid, id: "call-260-merge" },
  );
  // The session's repository is B (per the row); A's rows are foreign. The
  // provisional instance-A binding must NOT authorize the retirement.
  expect(String(res.content)).toContain("another repository");
  expect(
    (await loadAll()).find((m) => m.ts === loser)?.superseded_by,
  ).toBeUndefined();
});

test("control: a session whose row names A still merges A's rows", async () => {
  const sid = "ses-260-merge-own";
  const p = await loadPlugin(a);
  plugins.push(p);
  p.capture.session.row = { id: sid, location: { directory: a } };
  await seedA("A260_OWN_WINNER");
  await seedA("A260_OWN_LOSER");

  const res = await p.tools.memory_merge_review.execute(
    {
      loser: await tsOf("A260_OWN_LOSER"),
      survivor: await tsOf("A260_OWN_WINNER"),
      reason: "dupes",
    },
    { sessionID: sid, id: "call-260-own" },
  );
  expect(String(res.content)).toContain("Resolved merge");
});

test("forget resolves session identity before pruning (#260)", async () => {
  const sid = "ses-260-forget";
  const p = await serveHostSessionInB(sid);
  const row = await seedA("A260_FORGET_TARGET");

  const res = await p.tools.memory_forget.execute(
    { scope: "planning", type: "context", reason: "cross-repo probe" },
    { sessionID: sid, id: "call-260-forget" },
  );
  // B's reader sees no planning/context rows: nothing may be deleted, and
  // A's row must survive.
  expect(String(res.content)).toContain("No memories found");
  expect((await loadAll()).some((m) => m.ts === row)).toBe(true);
});

test("undo resolves session identity before restoring (#260)", async () => {
  const sid = "ses-260-undo";
  const p = await serveHostSessionInB(sid);
  await seedA("A260_UNDO_BASELINE");
  const [snapshot] = await snapshotFiles([
    (await loadAll()).find((m) => m.content.includes("A260_UNDO_BASELINE"))!
      .file,
  ]);

  await p.tools.memory_undo.execute(
    { snapshot: basename(snapshot!) },
    { sessionID: sid, id: "call-260-undo" },
  );
  // Whatever the restore decided, the caller's repository must have been
  // resolved from the host first — the same guarantee the write tools give.
  expect(p.capture.session.getCalls).toContain(sid);
});
