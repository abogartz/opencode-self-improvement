// Conflict-aware snapshot restore contract: a whole-file restore would clobber
// rows a CONCURRENT session promoted after the snapshot. Contract:
//   - check (default): refuse when the current file has rows added/changed
//     since the snapshot, listing them; file untouched;
//   - merge: restore the snapshot AND keep the divergent rows (superset);
//   - force: exact rollback (the pre-fix behavior, now opt-in);
//   - a bare snapshot name (as printed by list) resolves against snapshots/.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { addBlock, blocklistFile } from "../src/blocklist.ts";
import { memoryRoot, snapshotDir } from "../src/config.ts";
import { loadAll, prune, snapshotFiles } from "../src/memory.ts";
import { listSnapshots, restoreSnapshot } from "../src/undo.ts";
import { loadPlugin } from "./harness.ts";

const DAY = "2026-01-01";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-undo-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(memoryRoot(), { recursive: true });
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const store = () => join(memoryRoot(), `${DAY}.logfmt`);
const row = (n: number, extra = "") =>
  `ts=2026-01-01T00:00:0${n}.000Z type=learning scope=demo content="row ${n}"${extra}`;
const seed = (rows: string[]) => writeFileSync(store(), rows.join("\n") + "\n");
const lines = () => readFileSync(store(), "utf8").split("\n").filter(Boolean);

async function snapshotOfStore(): Promise<string> {
  const snaps = await snapshotFiles([store()]);
  expect(snaps.length).toBe(1);
  return snaps[0]!;
}

describe("restoreSnapshot modes", () => {
  test("clean file (no divergence): default check restores immediately", async () => {
    seed([row(1), row(2), row(3)]);
    const snap = await snapshotOfStore();
    const res = await restoreSnapshot(snap, memoryRoot());
    expect(res.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2), row(3)]);
  });

  test("concurrent rows: check refuses and leaves the file untouched", async () => {
    seed([row(1), row(2), row(3)]);
    const snap = await snapshotOfStore();
    // another session appends two rows after the snapshot
    seed([row(1), row(2), row(3), row(4), row(5)]);

    const res = await restoreSnapshot(snap, memoryRoot());
    expect(res.restored).toBe(false);
    expect(res.concurrentAdded).toEqual([
      "2026-01-01T00:00:04.000Z",
      "2026-01-01T00:00:05.000Z",
    ]);
    expect(lines().length).toBe(5); // file untouched
  });

  test("merge keeps the concurrent rows; force drops them", async () => {
    seed([row(1), row(2), row(3)]);
    const snap = await snapshotOfStore();
    seed([row(1), row(2), row(3), row(4), row(5)]);

    const merged = await restoreSnapshot(snap, memoryRoot(), "merge");
    expect(merged.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2), row(3), row(4), row(5)]);

    const forced = await restoreSnapshot(snap, memoryRoot(), "force");
    expect(forced.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2), row(3)]);
  });

  test("in-place edit after the snapshot counts as changed; merge keeps the edited row", async () => {
    seed([row(1), row(2), row(3)]);
    const snap = await snapshotOfStore();
    // another session stamps row 2 as superseded (in-place rewrite)
    seed([row(1), row(2, ' superseded_by="x" reason="drift"'), row(3)]);

    const refused = await restoreSnapshot(snap, memoryRoot());
    expect(refused.restored).toBe(false);
    expect(refused.concurrentChanged).toEqual(["2026-01-01T00:00:02.000Z"]);
    expect(refused.concurrentAdded).toEqual([]);

    const merged = await restoreSnapshot(snap, memoryRoot(), "merge");
    expect(merged.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2, ' superseded_by="x" reason="drift"'), row(3)]);
  });

  test("force snapshots what it drops: rows newer than the snapshot land in the safety copy", async () => {
    seed([row(1), row(2)]);
    const snap = await snapshotOfStore();
    // another session appends after the snapshot was taken
    seed([row(1), row(2), row(3)]);

    const res = await restoreSnapshot(snap, memoryRoot(), "force");
    expect(res.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2)]); // force means the new row goes
    expect(res.concurrentAdded).toEqual(["2026-01-01T00:00:03.000Z"]);
    // ...and it is not simply gone: the pre-restore file is snapshotted, from
    // under the lock, so it holds the row this call dropped.
    if (!res.safety) throw new Error("force restore returned no safety snapshot");
    expect(res.safety).not.toBe(snap);
    expect(readFileSync(res.safety, "utf8")).toContain("row 3");
  });

  test("check and merge keep every row, so they take no safety snapshot", async () => {
    seed([row(1), row(2)]);
    const snap = await snapshotOfStore();
    seed([row(1), row(2), row(3)]);

    expect((await restoreSnapshot(snap, memoryRoot())).safety).toBeUndefined();
    expect((await restoreSnapshot(snap, memoryRoot(), "merge")).safety).toBeUndefined();
    expect(lines().length).toBe(3);
  });

  test("bare snapshot name (as printed by list) resolves against snapshots/", async () => {
    seed([row(1), row(2)]);
    const snap = await snapshotOfStore();
    seed([row(1), row(2), row(3)]);
    const res = await restoreSnapshot(basename(snap), memoryRoot(), "force");
    expect(res.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2)]);
  });

  test("missing snapshot still throws", async () => {
    await expect(restoreSnapshot(`123-${DAY}.logfmt`, memoryRoot())).rejects.toThrow(
      "snapshot not found",
    );
  });

  test("an unaudited removal can still be restored from a normal snapshot", async () => {
    seed([row(1), row(2)]);
    const snap = await snapshotOfStore();
    seed([row(2)]);

    const res = await restoreSnapshot(basename(snap), memoryRoot());
    expect(res.restored).toBe(true);
    expect(lines()).toEqual([row(1), row(2)]);
  });

  test("default check does not resurrect a row deliberately forgotten after the snapshot", async () => {
    seed([row(1)]);
    const forgotten = await prune("demo", "learning", "remove leaked secret");
    expect(forgotten.snapshot).toHaveLength(1);
    const forgottenSnapshot = forgotten.snapshot[0];
    if (!forgottenSnapshot) throw new Error("expected a pre-forget snapshot");

    const res = await restoreSnapshot(basename(forgottenSnapshot), memoryRoot());
    expect(res.restored).toBe(true);
    expect(res.deletedOmitted).toEqual(["2026-01-01T00:00:01.000Z"]);
    expect(lines()).toEqual([]);
  });

  test("merge does not resurrect a forgotten row either; force does", async () => {
    seed([row(1)]);
    const forgotten = await prune("demo", "learning", "remove leaked secret");
    const forgottenSnapshot = forgotten.snapshot[0];
    if (!forgottenSnapshot) throw new Error("expected a pre-forget snapshot");

    const merged = await restoreSnapshot(basename(forgottenSnapshot), memoryRoot(), "merge");
    expect(merged.deletedOmitted).toEqual(["2026-01-01T00:00:01.000Z"]);
    expect(lines()).toEqual([]);

    const forced = await restoreSnapshot(basename(forgottenSnapshot), memoryRoot(), "force");
    expect(forced.deletedOmitted).toEqual([]);
    expect(lines()).toEqual([row(1)]);
  });

  test("blocklisted rows stay inactive when a store snapshot restores their raw row", async () => {
    seed([row(1)]);
    const snap = await snapshotOfStore();
    await addBlock("2026-01-01T00:00:01.000Z", "poisoned memory");
    seed([]);

    const res = await restoreSnapshot(basename(snap), memoryRoot(), "force");
    expect(res.restored).toBe(true);
    expect(lines()).toEqual([row(1)]);
    expect(await loadAll()).toHaveLength(0);
  });
});

describe("snapshot containment", () => {
  test("rejects impossible calendar dates and lists only valid snapshot names", async () => {
    mkdirSync(snapshotDir(), { recursive: true });
    const impossible = "123-2026-13-45.logfmt";
    const nonLeapDay = "124-2026-02-29.logfmt";
    const leapDay = "125-2028-02-29.logfmt";
    for (const name of [impossible, nonLeapDay, leapDay]) {
      writeFileSync(join(snapshotDir(), name), `${row(1)}\n`);
    }

    expect((await listSnapshots()).map((snapshot) => snapshot.name)).toEqual([leapDay]);
    for (const name of [impossible, nonLeapDay]) {
      await expect(restoreSnapshot(name, memoryRoot())).rejects.toThrow(
        `invalid snapshot name: ${name}`,
      );
    }

    const restored = await restoreSnapshot(leapDay, memoryRoot());
    expect(basename(restored.target)).toBe("2028-02-29.logfmt");
    expect(readFileSync(restored.target, "utf8")).toBe(`${row(1)}\n`);
  });

  test("a snapshot path escaping through .. is rejected", async () => {
    const name = `123-${DAY}.logfmt`;
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, name), `${row(1)}\n`);
    const traversing = `${snapshotDir()}${sep}..${sep}..${sep}outside${sep}${name}`;

    await expect(restoreSnapshot(traversing, memoryRoot(), "force")).rejects.toThrow(
      "outside the snapshots directory",
    );
    expect(existsSync(store())).toBe(false);
  });

  test("a snapshot symlink resolving outside snapshots is rejected", async () => {
    const name = `124-${DAY}.logfmt`;
    const outside = join(root, "outside", name);
    mkdirSync(join(root, "outside"), { recursive: true });
    mkdirSync(snapshotDir(), { recursive: true });
    writeFileSync(outside, `${row(1)}\n`);
    try {
      symlinkSync(outside, join(snapshotDir(), name));
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EPERM")) throw err;
      // Windows requires Developer Mode/admin for file symlinks. Directory
      // junctions need no elevation and exercise the same realpath escape.
      rmSync(snapshotDir(), { recursive: true });
      symlinkSync(join(root, "outside"), snapshotDir(), "junction");
    }

    await expect(restoreSnapshot(name, memoryRoot(), "force")).rejects.toThrow(/snapshots directory/);
    expect(existsSync(store())).toBe(false);
  });

  test("reserved store files cannot be targeted by a crafted snapshot name", async () => {
    mkdirSync(snapshotDir(), { recursive: true });
    for (const reserved of ["blocklist.logfmt", "canonical.logfmt"]) {
      const target = join(memoryRoot(), reserved);
      const original = `reserved ${reserved}\n`;
      writeFileSync(target, original);
      const crafted = join(snapshotDir(), `123-${reserved}`);
      writeFileSync(crafted, `${row(1)}\n`);

      await expect(restoreSnapshot(crafted, memoryRoot(), "force")).rejects.toThrow(
        "invalid snapshot name",
      );
      expect(readFileSync(target, "utf8")).toBe(original);
    }
  });

  test("export-then-undo cannot overwrite the blocklist and reactivate poison", async () => {
    seed([row(1)]);
    await addBlock("2026-01-01T00:00:01.000Z", "poisoned memory");
    const p = await loadPlugin(root);
    try {
      const exportTool = p.tools.memory_export;
      const undoTool = p.tools.memory_undo;
      if (!exportTool || !undoTool) throw new Error("memory tools were not registered");
      const exported = join(root, "blocklist.logfmt");
      await exportTool.execute({ file: exported });

      await expect(
        undoTool.execute({ snapshot: exported, force: true }),
      ).rejects.toThrow("invalid snapshot name");
      expect(readFileSync(blocklistFile(), "utf8")).toContain(
        "ts=2026-01-01T00:00:01.000Z",
      );
      expect(await loadAll()).toHaveLength(0);
    } finally {
      await p.cleanup();
    }
  });
});

describe("memory_undo tool guidance", () => {
  test("refusal message names the divergent rows and both escape hatches", async () => {
    const p = await loadPlugin(root);
    seed([row(1), row(2)]);
    const snap = basename(await snapshotOfStore());
    seed([row(1), row(2), row(3)]);

    const refused = await p.tools.memory_undo!.execute({ snapshot: snap });
    expect(refused.content).toContain("Undo refused");
    expect(refused.content).toContain("2026-01-01T00:00:03.000Z");
    expect(refused.content).toContain("merge=true");
    expect(refused.content).toContain("force=true");
    expect(lines().length).toBe(3);

    const kept = await p.tools.memory_undo!.execute({ snapshot: snap, merge: true });
    expect(kept.content).toContain("Restored");
    expect(kept.content).toContain("Kept 1 added");
    expect(lines().length).toBe(3);

    p.cleanup();
  });
});
