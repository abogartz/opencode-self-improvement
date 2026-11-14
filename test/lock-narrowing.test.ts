// Contract (#215): a single-row store mutation must not pay one lock per day of
// store age. Superseding one row used to lock, read and rewrite-scan EVERY day
// file, so the cost grew linearly with how long the install had been alive
// (measured on a synthetic 30 x 10 store: loadAll 4.6 ms, supersede ONE row
// 116 ms, ~113 ms of it the lock sweep).
//
// A row's own ts names the day file it was appended to, so the containing file
// is known without looking. The mapping is a hint, never a proof — a store
// edited outside the plugin can hold a row somewhere else — so the write paths
// still sweep the remaining files until they have SEEN the row. That is what
// these tests pin, in both directions: one lock on the normal path, and the old
// behaviour preserved for a store that breaks the mapping.
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { resetState } from "../src/core/state.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { loadAll, memoryFiles } from "../src/store/files/load.ts";
import { prune } from "../src/store/files/prune.ts";
import {
  clearSuperseded,
  markSuperseded,
} from "../src/store/files/supersede.ts";
import {
  LOCK_WRITE,
  setLockAcquiredHook,
  withStoreLock,
} from "../src/store/lock.ts";
import { releaseQuarantine } from "../src/store/quarantine/release.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-215-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  mkdirSync(memoryRoot(), { recursive: true });
});

afterEach(() => {
  setLockAcquiredHook();
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

/**
 * A store with real age: `days` day files x `perDay` rows, each row's ts inside
 * the day file it is written to (what appendMemory does — it mints ts at write
 * time and appends to that same day file).
 */
function seedStore(
  days: number,
  perDay: number,
): { ts: string; file: string }[] {
  const rows: { ts: string; file: string }[] = [];
  const base = Date.UTC(2026, 0, 1);
  for (let d = 0; d < days; d++) {
    const day = new Date(base + d * 86_400_000).toISOString().slice(0, 10);
    const file = join(memoryRoot(), `${day}.logfmt`);
    const lines: string[] = [];
    for (let i = 0; i < perDay; i++) {
      const ts = `${day}T10:00:${String(i).padStart(2, "0")}.000Z`;
      lines.push(
        formatLine({
          ts,
          type: "learning",
          scope: `scope-${d}-${i}`,
          content: `row ${d} ${i} holds a distinct fact about the nightly archive job`,
        }),
      );
      rows.push({ ts, file });
    }
    appendFileSync(file, `${lines.join("\n")}\n`);
  }
  return rows;
}

/** A seeded row, without a non-null assertion the lint baseline does not need. */
function pick(
  rows: { ts: string; file: string }[],
  index: number,
): { ts: string; file: string } {
  const row = rows[index];
  if (!row) throw new Error(`fixture has no seeded row ${index}`);
  return row;
}

/** Run `body` with lock acquisitions recorded; returns what it returned. */
async function withLockLog<T>(body: () => Promise<T>): Promise<[T, string[]]> {
  const locked: string[] = [];
  setLockAcquiredHook((file) => locked.push(file));
  try {
    return [await body(), locked];
  } finally {
    setLockAcquiredHook();
  }
}

test("superseding one row locks only the day file that holds it", async () => {
  const rows = seedStore(30, 10);
  expect((await memoryFiles()).length).toBe(30);
  const target = pick(rows, rows.length - 1);

  const [marked, locked] = await withLockLog(() =>
    markSuperseded(target.ts, {
      superseded_by: "2026-02-01T00:00:00.000Z",
      reason: "superseded by a newer note",
    }),
  );

  expect(marked).toBe(true);
  expect([...new Set(locked)]).toEqual([target.file]);
  // The row really retired, and its neighbours are untouched.
  const all = await loadAll();
  const row = all.find((m) => m.ts === target.ts);
  expect(row?.superseded_by).toBe("2026-02-01T00:00:00.000Z");
  expect(all.filter((m) => m.superseded_by).length).toBe(1);
});

test("clearing a supersession locks only the day file that holds the row", async () => {
  const rows = seedStore(30, 10);
  const target = pick(rows, 123);
  await markSuperseded(target.ts, {
    superseded_by: "2026-02-01T00:00:00.000Z",
    reason: "superseded by a newer note",
  });

  const [cleared, locked] = await withLockLog(() => clearSuperseded(target.ts));

  expect(cleared).toBe(true);
  expect([...new Set(locked)]).toEqual([target.file]);
});

test("releasing quarantine locks only the day file that holds the row", async () => {
  const rows = seedStore(30, 10);
  // A LATE row: on the swept path the walk starts at the first day file, so a
  // target near the end is what makes the difference visible.
  const target = pick(rows, 283);
  expect(target.ts.startsWith("2026-01-29")).toBe(true);
  // Tag it quarantine the way the scanner's promotion would, then release it.
  const file = target.file;
  const text = await Bun.file(file).text();
  await Bun.write(
    file,
    text.replace(
      `ts=${target.ts} type=learning scope=scope-28-3`,
      `ts=${target.ts} type=learning scope=scope-28-3 tags=quarantine,quarantine:instruction_override`,
    ),
  );

  const [result, locked] = await withLockLog(() =>
    releaseQuarantine(target.ts),
  );

  expect(result).toBe("released");
  expect([...new Set(locked)]).toEqual([target.file]);
});

// Deliberate, and documented in prune.ts: a forget is addressed by scope/type,
// not by ts, so it keeps the full sweep — narrowing it to a pre-pass would let a
// row appended during the forget survive it. This pins that choice so a future
// "optimisation" has to argue with a test.
test("prune keeps sweeping every day file: a forget must not miss a late match", async () => {
  const rows = seedStore(30, 10);
  const victim = pick(rows, 45);

  const [res, locked] = await withLockLog(() =>
    prune("scope-4-5", "learning", "operator forgets this scope"),
  );

  expect(res.deleted.map((d) => d.memory.ts)).toEqual([victim.ts]);
  expect(new Set(locked).size).toBeGreaterThan(1);
});

test("a row whose ts does not name its file is still found (mapping is a hint)", async () => {
  // A store edited outside the plugin: a row carrying 2026-01-05's ts sitting in
  // 2026-01-20's file. The narrowed path must fall back to the sweep it replaced.
  seedStore(30, 10);
  const oddFile = join(memoryRoot(), "2026-01-20.logfmt");
  const oddTs = "2026-01-05T11:11:11.000Z";
  appendFileSync(
    oddFile,
    `${formatLine({
      ts: oddTs,
      type: "learning",
      scope: "misfiled",
      content: "a hand-edited store keeps a row outside the day its ts names",
    })}\n`,
  );

  const marked = await markSuperseded(oddTs, {
    superseded_by: "2026-02-01T00:00:00.000Z",
    reason: "found by the fallback sweep",
  });

  expect(marked).toBe(true);
  const row = (await loadAll()).find((m) => m.ts === oddTs);
  expect(row?.superseded_by).toBe("2026-02-01T00:00:00.000Z");
});

// The ticket's third acceptance clause, named for this file: narrowing the lock
// set must not narrow the safety. Contention on the ONE file we now touch still
// refuses instead of writing, exactly as the swept version did.
test("contention on the containing day file still refuses the supersede", async () => {
  const rows = seedStore(30, 10);
  const target = pick(rows, 9);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  const released = new Promise<void>((r) => (release = r));
  const holder = withStoreLock(
    target.file,
    async () => {
      enter();
      await released;
    },
    LOCK_WRITE,
  );
  await entered;
  try {
    await expect(
      markSuperseded(target.ts, {
        superseded_by: "2026-02-01T00:00:00.000Z",
        reason: "must not write while another writer holds the file",
      }),
    ).rejects.toThrow(/busy/);
    expect((await loadAll()).some((m) => m.superseded_by)).toBe(false);
  } finally {
    release();
    await holder;
  }
}, 30_000);

// The narrowing addresses a row by the day its own ts names, so it is only ever
// as safe as the claim that a plugin-written row lives in the file its ts names
// (#373 review). appendMemory picked the file from the clock and bumped a
// colliding ts inside the lock, which made the claim false at UTC midnight: two
// files could hold the same ts, and a retirement that stopped at the first copy
// reported success while leaving the second live.
test("appendMemory never stores a ts under another day's file", async () => {
  setSystemTime(new Date("2026-01-05T23:59:59.999Z"));
  const first = await appendMemory({
    type: "learning",
    scope: "edge-a",
    content: "first row written at the day boundary, twice in one millisecond",
    repo: "global",
  });
  const second = await appendMemory({
    type: "learning",
    scope: "edge-b",
    content: "second row in the same millisecond, so its ts is bumped forward",
    repo: "global",
  });
  setSystemTime(new Date("2026-01-06T00:00:00.000Z"));
  const third = await appendMemory({
    type: "learning",
    scope: "edge-c",
    content: "third row one millisecond later, in the next day's file",
    repo: "global",
  });
  setSystemTime();

  const homes = new Map<string, string[]>();
  for (const file of await memoryFiles()) {
    const text = await Bun.file(file).text();
    for (const ts of [first, second, third]) {
      if (!text.includes(`ts=${ts}`)) continue;
      homes.set(ts, [...(homes.get(ts) ?? []), basename(file)]);
    }
  }
  expect(homes.get(first)).toEqual(["2026-01-05.logfmt"]);
  // The bumped ts says 01-06, so 01-06 is where it must live.
  expect(homes.get(second)).toEqual(["2026-01-06.logfmt"]);
  expect(homes.get(third)).toEqual(["2026-01-06.logfmt"]);
});

test("a ts duplicated across two day files retires in BOTH copies", async () => {
  // What the boundary bug left behind, planted directly: the same ts in the day
  // it names and in the day before it.
  seedStore(30, 10);
  const dup = "2026-01-15T23:59:59.999Z";
  for (const day of ["2026-01-15", "2026-01-14"]) {
    appendFileSync(
      join(memoryRoot(), `${day}.logfmt`),
      `${formatLine({
        ts: dup,
        type: "learning",
        scope: `dup-${day}`,
        content: `a copy of the same identity in ${day}, from the boundary collision`,
      })}\n`,
    );
  }

  const marked = await markSuperseded(dup, {
    superseded_by: "2026-02-01T00:00:00.000Z",
    reason: "retire every copy",
  });

  expect(marked).toBe(true);
  const live = (await loadAll()).filter(
    (m) => m.ts === dup && !m.superseded_by,
  );
  expect(live).toEqual([]);
});

test("a supersede of a row that does not exist locks nothing extra and marks nothing", async () => {
  seedStore(30, 10);
  const [marked, locked] = await withLockLog(() =>
    markSuperseded("2027-03-04T09:08:07.000Z", {
      superseded_by: "2026-02-01T00:00:00.000Z",
      reason: "no such row",
    }),
  );
  expect(marked).toBe(false);
  // The absent row cannot be resolved by name, so the fallback sweep still runs
  // (that is the honest cost of a miss) — but nothing is rewritten.
  expect(locked.length).toBeGreaterThan(0);
  expect((await loadAll()).some((m) => m.superseded_by)).toBe(false);
});
