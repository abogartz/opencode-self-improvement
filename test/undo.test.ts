// Conflict-aware snapshot restore contract: a whole-file restore would clobber
// rows a CONCURRENT session promoted after the snapshot. Contract:
//   - check (default): refuse when the current file has rows added/changed
//     since the snapshot, listing them; file untouched;
//   - merge: restore the snapshot AND keep the divergent rows (superset);
//   - force: exact rollback (the pre-fix behavior, now opt-in), minus rows
//     whose content carries a rejection tombstone (#307, decision #214 A).
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
import { addBlock, blocklistFile } from "../src/store/blocklist.ts";
import { rejectedFile } from "../src/store/tombstones/rejection.ts";
import { memoryRoot, snapshotDir } from "../src/core/config/paths.ts";
import { loadAll } from "../src/store/files/load.ts";
import { prune } from "../src/store/files/prune.ts";
import { snapshotFiles } from "../src/store/files/snapshots.ts";
import { listSnapshots, restoreSnapshot } from "../src/store/undo.ts";
import { loadPlugin } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

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
  removeStore(root);
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
    expect(lines()).toEqual([
      row(1),
      row(2, ' superseded_by="x" reason="drift"'),
      row(3),
    ]);
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
    if (!res.safety)
      throw new Error("force restore returned no safety snapshot");
    expect(res.safety).not.toBe(snap);
    expect(readFileSync(res.safety, "utf8")).toContain("row 3");
  });

  test("check and merge keep every row, so they take no safety snapshot", async () => {
    seed([row(1), row(2)]);
    const snap = await snapshotOfStore();
    seed([row(1), row(2), row(3)]);

    expect((await restoreSnapshot(snap, memoryRoot())).safety).toBeUndefined();
    expect(
      (await restoreSnapshot(snap, memoryRoot(), "merge")).safety,
    ).toBeUndefined();
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
    await expect(
      restoreSnapshot(`123-${DAY}.logfmt`, memoryRoot()),
    ).rejects.toThrow("snapshot not found");
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

    const res = await restoreSnapshot(
      basename(forgottenSnapshot),
      memoryRoot(),
    );
    expect(res.restored).toBe(true);
    expect(res.deletedOmitted).toEqual(["2026-01-01T00:00:01.000Z"]);
    expect(lines()).toEqual([]);
  });

  test("merge does not resurrect a forgotten row either; force omits it (#307)", async () => {
    seed([row(1)]);
    const forgotten = await prune("demo", "learning", "remove leaked secret");
    const forgottenSnapshot = forgotten.snapshot[0];
    if (!forgottenSnapshot) throw new Error("expected a pre-forget snapshot");

    const merged = await restoreSnapshot(
      basename(forgottenSnapshot),
      memoryRoot(),
      "merge",
    );
    expect(merged.deletedOmitted).toEqual(["2026-01-01T00:00:01.000Z"]);
    expect(lines()).toEqual([]);

    const forced = await restoreSnapshot(
      basename(forgottenSnapshot),
      memoryRoot(),
      "force",
    );
    // #214 A overturned the pre-fix contract ("force does" resurrect): the
    // prune left a rejection tombstone on the row's content, so force reports
    // the row in rejectedOmitted and leaves it non-recallable.
    expect(forced.deletedOmitted).toEqual([]);
    expect(forced.rejectedOmitted).toEqual(["2026-01-01T00:00:01.000Z"]);
    expect(lines()).toEqual([]);
    expect(await loadAll()).toHaveLength(0);
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

    expect((await listSnapshots()).map((snapshot) => snapshot.name)).toEqual([
      leapDay,
    ]);
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

    await expect(
      restoreSnapshot(traversing, memoryRoot(), "force"),
    ).rejects.toThrow("outside the snapshots directory");
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
      if (!(err instanceof Error && "code" in err && err.code === "EPERM"))
        throw err;
      // Windows requires Developer Mode/admin for file symlinks. Directory
      // junctions need no elevation and exercise the same realpath escape.
      removeStore(snapshotDir());
      symlinkSync(join(root, "outside"), snapshotDir(), "junction");
    }

    await expect(restoreSnapshot(name, memoryRoot(), "force")).rejects.toThrow(
      /snapshots directory/,
    );
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

      await expect(
        restoreSnapshot(crafted, memoryRoot(), "force"),
      ).rejects.toThrow("invalid snapshot name");
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
      if (!exportTool || !undoTool)
        throw new Error("memory tools were not registered");
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

    const kept = await p.tools.memory_undo!.execute({
      snapshot: snap,
      merge: true,
    });
    expect(kept.content).toContain("Restored");
    expect(kept.content).toContain("Kept 1 added");
    expect(lines().length).toBe(3);

    p.cleanup();
  });
});

describe("memory_undo force and rejection tombstones (#307, decision #214 A)", () => {
  // #35's stated property: no tool lifts a rejection. FORCE is the only mode
  // that republishes rows deleted since the snapshot, so it alone must consult
  // the rejection tombstones — a restore that reinstates a tombstoned value
  // leaves the store holding an active row it also records as rejected.
  test("force omits a forgotten row instead of reviving it; it stays non-recallable", async () => {
    seed([row(1)]);
    const snap = basename(await snapshotOfStore());
    const p = await loadPlugin(root);
    try {
      const forgotten = await p.tools.memory_forget!.execute({
        type: "learning",
        scope: "demo",
        reason: "rejected value",
      });
      expect(forgotten.content).toContain("Deleted 1");

      const forced = await p.tools.memory_undo!.execute({
        snapshot: snap,
        force: true,
      });
      expect(forced.content).toContain("Restored");
      // The row's content carries a rejection tombstone: force must not
      // republish it, and the row stays non-recallable.
      expect(lines()).toEqual([]);
      expect(await loadAll()).toHaveLength(0);
      expect(forced.content).toContain("rejected");
    } finally {
      await p.cleanup();
    }
  });

  test("force reports rejectedOmitted, leaves the tombstone file byte-identical, and still restores ordinary deletions", async () => {
    const foreignScopeRow =
      'ts=2026-01-01T00:00:03.000Z type=learning scope=other content="row 3"';
    seed([row(1), row(2), foreignScopeRow]);
    const snap = basename(await snapshotOfStore());
    // Forget rows 1+2 (deletion audit + rejection tombstones), then drop row 3
    // by ordinary means: no audit, no tombstone — force must restore it.
    await prune("demo", "learning", "rejected value");
    seed([]);
    const tombstonesBefore = readFileSync(rejectedFile());

    const res = await restoreSnapshot(snap, memoryRoot(), "force");
    expect(res.restored).toBe(true);
    expect(lines()).toEqual([foreignScopeRow]);
    expect(res.rejectedOmitted).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
    ]);
    // The restored store holds exactly the ordinarily-deleted row: the two
    // rejected contents stayed out and are non-recallable.
    expect((await loadAll()).map((m) => m.ts)).toEqual([
      "2026-01-01T00:00:03.000Z",
    ]);
    // The tombstone evidence itself is never edited or deleted by a restore.
    expect(readFileSync(rejectedFile())).toEqual(tombstonesBefore);
  });

  test("default and merge undo do not resurrect a rejected value through an older identity (#307 F1)", async () => {
    // The rejection floor is keyed on the VALUE, not the row identity, so it
    // must hold in every mode. An older snapshot identity can carry a value a
    // human later rejected through a DIFFERENT row: a force rollback drops the
    // original with no deletion audit, then a later copy is forgotten. The
    // identity-keyed deletion audit misses the original, so only the value
    // floor keeps CHECK and MERGE from reviving it.
    const t1 =
      'ts=2026-01-01T00:00:01.000Z type=learning scope=demo content="use the deprecated endpoint for auth"';
    const t2 =
      'ts=2026-01-01T00:00:02.000Z type=learning scope=demo content="use the deprecated endpoint for auth"';

    // S0: an empty day file. S1: the value present as row T1.
    seed([]);
    const s0 = basename(await snapshotOfStore());
    seed([t1]);
    const s1 = basename(await snapshotOfStore());

    // Force-undo S0: T1 disappears through legitimate rollback — no human
    // deletion audit is written for T1.
    const rolled = await restoreSnapshot(s0, memoryRoot(), "force");
    expect(rolled.restored).toBe(true);
    expect(lines()).toEqual([]);

    // Store a later copy T2 of the same value, then forget it: this audits T2
    // and tombstones the VALUE. The store is empty; T1 still has no audit.
    seed([t2]);
    const forgotten = await prune("demo", "learning", "rejected value");
    expect(forgotten.deleted).toHaveLength(1);
    expect(lines()).toEqual([]);
    const tombstonesBefore = readFileSync(rejectedFile());

    // Undo S1 in default (check) mode: T1 carries the rejected value, so it
    // stays omitted even though its identity was never audited as deleted.
    const checked = await restoreSnapshot(s1, memoryRoot());
    expect(checked.restored).toBe(true);
    expect(checked.rejectedOmitted).toEqual(["2026-01-01T00:00:01.000Z"]);
    expect(lines()).toEqual([]);
    expect(await loadAll()).toHaveLength(0);

    // Undo S1 with merge=true: the same floor on merge's reconciliation.
    const merged = await restoreSnapshot(s1, memoryRoot(), "merge");
    expect(merged.restored).toBe(true);
    expect(merged.rejectedOmitted).toEqual(["2026-01-01T00:00:01.000Z"]);
    expect(lines()).toEqual([]);
    expect(await loadAll()).toHaveLength(0);

    // The tombstone evidence is never edited by any of these restores.
    expect(readFileSync(rejectedFile())).toEqual(tombstonesBefore);
  });
});
