// Probes for #153: model-facing rollback must respect row ownership. A
// snapshot names a whole DAY FILE, which is shared across repositories, so a
// force restore run from repo A silently rewrote or dropped repo B's private
// rows — the undo twin of #131's rule that a known id is not authority, and of
// #143's export breadth: authorization belongs to the entry point, and every
// mode (check/merge/force) must leave foreign rows exactly where they are.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { appendMemory } from "../src/store/files/append.ts"
import { loadAll } from "../src/store/files/load.ts"
import { snapshotFiles } from "../src/store/files/snapshots.ts"
import { markSuperseded } from "../src/store/files/supersede.ts";
import { rememberSessionDir, resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";

let root: string;
let a: string;
let b: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-undo-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
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
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("osi-undo-")) {
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
const ctx = (sessionID: string) => ({ sessionID, id: "undo-proof" });

describe("memory_undo respects row ownership (#153)", () => {
  test("force undo from A must preserve a private B row that A cannot read", async () => {
    const pa = await plugin(a);
    const own = await seed(a, "A_SNAPSHOT_BASELINE");
    const file = (await loadAll()).find((m) => m.ts === own)!.file;
    const [snapshot] = await snapshotFiles([file]);
    const foreign = await seed(b, "B_PRIVATE_ROW_ADDED_AFTER_A_SNAPSHOT");
    const hidden = await pa.tools.memory_recall.execute(
      { query: "B_PRIVATE_ROW_ADDED_AFTER_A_SNAPSHOT" },
      ctx("ses-a"),
    );
    expect(hidden.content).not.toContain("B_PRIVATE_ROW_ADDED_AFTER_A_SNAPSHOT");
    const listed = await pa.tools.memory_undo.execute({ list: true }, ctx("ses-a"));
    expect(listed.content).toContain(basename(snapshot!));
    const result = await pa.tools.memory_undo.execute(
      { snapshot: basename(snapshot!), force: true },
      ctx("ses-a"),
    );
    expect(result.content).toContain("Restored");
    expect((await loadAll()).some((m) => m.ts === foreign)).toBe(true);
  });

  test("control: default undo refuses a rollback that would erase a later row", async () => {
    const pa = await plugin(a);
    const own = await seed(a, "A_SNAPSHOT_BASELINE");
    const [snapshot] = await snapshotFiles([(await loadAll()).find((m) => m.ts === own)!.file]);
    const foreign = await seed(b, "B_LATER_PRIVATE_ROW");
    const result = await pa.tools.memory_undo.execute({ snapshot: basename(snapshot!) }, ctx("ses-a"));
    expect(result.content).toContain("Undo refused");
    expect((await loadAll()).some((m) => m.ts === foreign)).toBe(true);
  });

  test("force undo must not rewind a foreign row's supersession either", async () => {
    const pa = await plugin(a);
    const own = await seed(a, "A_SNAPSHOT_BASELINE");
    const bNext = await seed(b, "B_SUCCESSOR_ROW");
    const bRow = await seed(b, "B_ROW_SUPERSEDED_AFTER_A_SNAPSHOT");
    const [snapshot] = await snapshotFiles([(await loadAll()).find((m) => m.ts === own)!.file]);
    await markSuperseded(bRow, { superseded_by: bNext, reason: "update", symbol: bRow, from: bRow, to: bNext });
    const result = await pa.tools.memory_undo.execute(
      { snapshot: basename(snapshot!), force: true },
      ctx("ses-a"),
    );
    expect(result.content).toContain("Restored");
    // The live (post-snapshot) version of the FOREIGN row wins in every mode:
    // rewinding another repo's retirement is a write to rows A cannot recall,
    // forget, or merge.
    expect((await loadAll()).find((m) => m.ts === bRow)?.superseded_by).toBe(bNext);
  });

  test("merge undo leaves foreign rows exactly where they are", async () => {
    const pa = await plugin(a);
    const own = await seed(a, "A_SNAPSHOT_BASELINE");
    const [snapshot] = await snapshotFiles([(await loadAll()).find((m) => m.ts === own)!.file]);
    const foreign = await seed(b, "B_PRIVATE_ROW_AFTER_A_SNAPSHOT");
    const later = await seed(a, "A_LATER_ROW_MERGE_MODE_KEEPS");
    const result = await pa.tools.memory_undo.execute(
      { snapshot: basename(snapshot!), merge: true },
      ctx("ses-a"),
    );
    expect(result.content).toContain("Restored");
    const all = await loadAll();
    expect(all.some((m) => m.ts === foreign)).toBe(true);
    expect(all.some((m) => m.ts === later)).toBe(true);
  });

  test("contract: a global row appended after the snapshot is in every repo's rollback scope", async () => {
    // The documented exception to the ownership rule (#153 review, F2):
    // repo=global — and legacy unstamped — rows are visible to EVERY reader,
    // so restore counts them as own rows and a force rollback from A drops a
    // global line written after A's snapshot. Deliberate: "act on exactly
    // what you may read" (#131), the same rule memory_forget applies to
    // global scope. Pinned so the next reader inherits the decision instead
    // of rediscovering it.
    const pa = await plugin(a);
    const own = await seed(a, "A_SNAPSHOT_BASELINE");
    const [snapshot] = await snapshotFiles([(await loadAll()).find((m) => m.ts === own)!.file]);
    setRepoScope(null); // no module scope in play: the row lands GLOBAL unstamped
    const shared = await appendMemory({ type: "context", scope: "s", content: "GLOBAL_ROW_AFTER_A_SNAPSHOT" });
    const result = await pa.tools.memory_undo.execute(
      { snapshot: basename(snapshot!), force: true },
      ctx("ses-a"),
    );
    expect(result.content).toContain("Restored");
    expect((await loadAll()).some((m) => m.ts === shared)).toBe(false);
  });

  test("control: same-repo force undo still rolls back the caller's own rows", async () => {
    const pa = await plugin(a);
    rememberSessionDir("ses-a", a);
    const own = await seed(a, "A_WILL_BE_UNDONE");
    const [snapshot] = await snapshotFiles([(await loadAll()).find((m) => m.ts === own)!.file]);
    await seed(a, "A_LATER_ROW_FORCE_DROPS");
    const result = await pa.tools.memory_undo.execute(
      { snapshot: basename(snapshot!), force: true },
      ctx("ses-a"),
    );
    expect(result.content).toContain("Restored");
    const all = await loadAll();
    expect(all.some((m) => m.ts === own)).toBe(true);
    expect(all.some((m) => m.content === "A_LATER_ROW_FORCE_DROPS")).toBe(false);
  });
});
