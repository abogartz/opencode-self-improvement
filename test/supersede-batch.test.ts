// Batch supersession (#61): decay and the gate's neutralization loops used to
// call markSuperseded per row - N full lock/read/rewrite/snapshot/publish
// cycles, N undo points for one logical operation. markManySuperseded does one
// pass per file: N rows, ONE snapshot, ONE publish. These tests pin:
//   - the snapshot economy (the actual regression gate - red pre-fix),
//   - idempotence (re-run writes nothing),
//   - marker conservation (out-of-band marks survive),
//   - a concurrent append surviving the batch window,
//   - the single-row wrapper keeping markSuperseded's exact boolean contract.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemory, loadAll, markManySuperseded, markSuperseded } from "../src/memory.ts";
import { formatLine } from "../src/logfmt.ts";
import { setRepoScope } from "../src/repokey.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-batch-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
});
afterEach(() => {
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const memDir = () => process.env.OPENCODE_MEMORY_DIR!;
const dayName = (offsetDays = 0) => `${new Date(Date.now() - offsetDays * 86_400_000).toISOString().split("T")[0]}.logfmt`;
const dayFile = (offsetDays = 0) => join(memDir(), dayName(offsetDays));
const snaps = () => (existsSync(join(memDir(), "snapshots")) ? readdirSync(join(memDir(), "snapshots")) : []);
const batch = (ts: string[], by = "batch") => ts.map((t) => ({ ts: t, fields: { superseded_by: by, reason: "drift" } }));

describe("markManySuperseded (batch supersession, #61)", () => {
  test("rows across two day files retire with ONE snapshot per touched file, not per row", async () => {
    const today: string[] = [];
    for (let i = 0; i < 4; i++) {
      today.push(await appendMemory({ type: "learning", scope: "batch", content: `batch row ${i} about pipelines and caches here` }));
    }
    // Hand-plant yesterday's file (appendMemory always writes today's): two valid rows.
    const older = ["2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.001Z"];
    writeFileSync(
      dayFile(1),
      older.map((ts, i) => formatLine({ ts, type: "learning", scope: "batch", content: `old row ${i} about archives and vaults here` })).join("\n") + "\n",
    );

    const before = snaps().length;
    const marked = await markManySuperseded(batch([...today, ...older]));
    expect(marked).toBe(6);
    // The regression gate: 2 files touched -> 2 snapshots. A per-row loop
    // (the pre-fix behavior) produces 6 and fails here.
    expect(snaps().length - before).toBe(2);

    const all = await loadAll();
    expect(all.filter((m) => m.superseded_by === "batch").length).toBe(6);
  });

  test("re-running the batch marks nothing and writes nothing new", async () => {
    const ts = [];
    for (let i = 0; i < 3; i++) {
      ts.push(await appendMemory({ type: "learning", scope: "idemp", content: `idempotent row ${i} about reruns and ledgers here` }));
    }
    expect(await markManySuperseded(batch(ts))).toBe(3);
    const snapsN = snaps().length;
    const raw = readFileSync(dayFile(), "utf8");

    expect(await markManySuperseded(batch(ts))).toBe(0);
    expect(snaps().length).toBe(snapsN); // no undo point for a no-op
    expect(readFileSync(dayFile(), "utf8")).toBe(raw); // byte-identical
  });

  test("a row marked out-of-band keeps its original marker through the batch", async () => {
    const a = await appendMemory({ type: "learning", scope: "mixed", content: "first row about deploys and rollbacks here" });
    const b = await appendMemory({ type: "learning", scope: "mixed", content: "second row about deploys and rollouts here" });
    expect(await markSuperseded(a, { superseded_by: "someone-else", reason: "manual" })).toBe(true);

    const marked = await markManySuperseded(batch([a, b]));
    expect(marked).toBe(1); // only the unmarked row retires HERE
    const all = await loadAll();
    const rowA = all.find((m) => m.ts === a)!;
    expect(rowA.superseded_by).toBe("someone-else"); // conservation: never overwritten
    expect(rowA.reason).toBe("manual");
    expect(all.find((m) => m.ts === b)!.superseded_by).toBe("batch");
  });

  test("an append racing the batch pass survives either interleaving", async () => {
    const ts = [];
    for (let i = 0; i < 5; i++) {
      ts.push(await appendMemory({ type: "learning", scope: "race", content: `race base row ${i} about locks and queues here` }));
    }
    const [marked, lateTs] = await Promise.all([
      markManySuperseded(batch(ts)),
      appendMemory({ type: "learning", scope: "race", content: "the late append must never be swallowed" }),
    ]);
    expect(marked).toBe(5);
    const raw = readFileSync(dayFile(), "utf8");
    expect(raw).toContain(`ts=${lateTs}`);
    expect((await loadAll()).filter((m) => m.superseded_by === "batch").length).toBe(5);
    expect((await loadAll()).find((m) => m.ts === lateTs)!.superseded_by).toBeUndefined();
  });

  test("the single-row wrapper keeps markSuperseded's exact boolean contract", async () => {
    const live = await appendMemory({ type: "learning", scope: "wrap", content: "wrapper subject row about booleans and contracts here" });
    expect(await markSuperseded("1970-01-01T00:00:00.000Z", { superseded_by: "x", reason: "drift" })).toBe(false); // absent
    expect(await markSuperseded(live, { superseded_by: "x", reason: "drift" })).toBe(true);
    expect(await markSuperseded(live, { superseded_by: "y", reason: "drift" })).toBe(false); // already marked
  });

  test("duplicate ts entries in one batch: first entry's fields win", async () => {
    const ts = await appendMemory({ type: "learning", scope: "dup", content: "duplicate entries row about precedence and order here" });
    const marked = await markManySuperseded([
      { ts, fields: { superseded_by: "first", reason: "drift" } },
      { ts, fields: { superseded_by: "second", reason: "canonical" } },
    ]);
    expect(marked).toBe(1);
    expect((await loadAll()).find((m) => m.ts === ts)!.superseded_by).toBe("first");
  });
});

// #106: the batch path shipped in #102 published WITHOUT the fileIdentity
// anchor #89 made standard for whole-file read-modify-writes. On Windows,
// mandatory locking refuses the handover rename while any reader still holds
// the destination, so an unanchored batch publish either dies on the refusal
// (losing an ordinary retirement to contention) or - if it retried blind -
// would republish stale lines over anything that moved the file. Anchored,
// the healthy shape retries and lands; the stale shape aborts honestly.
// POSIX never takes this path (rename swaps under readers), hence the gate:
// the pre-fix red leg is windows-latest CI, and this file's Linux behavior is
// byte-identical with or without the anchor.
describe.skipIf(process.platform !== "win32")("batch publish under Windows reader contention (#106)", () => {
  function held(file: string): { release: () => void } {
    const fd = openSync(file, "r"); // node shares read/write but NOT delete: rename is blocked
    let closed = false;
    return {
      release: () => {
        if (!closed) {
          closed = true;
          closeSync(fd);
        }
      },
    };
  }

  test("a batch publish survives a reader holding the destination: retry, not a lost retirement", async () => {
    const ts = await appendMemory({ type: "learning", scope: "batch", content: "a row retired during reader contention here" });
    const file = dayFile();
    const h = held(file);
    setTimeout(h.release, 400); // the anchored retry window reopens the rename before it closes
    // Red pre-fix: writeAtomic with no anchor does ONE rename, hits the
    // refusal, and throws the retirement away - the exact deadline-shape
    // #89 fixed for stampRow, in the batch that bypassed it.
    expect(await markManySuperseded(batch([ts]))).toBe(1);
    expect((await loadAll()).find((m) => m.ts === ts)!.superseded_by).toBe("batch");
    h.release();
  });

  test("an append landing mid-window aborts the batch publish; the append survives and a retry lands", async () => {
    const ts = await appendMemory({ type: "learning", scope: "batch", content: "a row whose batch races a degraded writer here" });
    const file = dayFile();
    const h = held(file);
    setTimeout(h.release, 1500); // never reached: the staleness check fires first
    const stray = "2020-06-01T00:00:00.000Z";
    const publish = markManySuperseded(batch([ts])).then(
      () => "ok",
      () => "failed",
    );
    // Simulate an out-of-band/legacy writer bypassing the lock. Current
    // LOCK_WRITE callers fail closed, but this defense must still hold.
    await Bun.sleep(60).then(() =>
      appendFile(file, formatLine({ ts: stray, type: "learning", scope: "batch", content: "degraded mid-window append here" }) + "\n"),
    );
    expect(await publish).toBe("failed"); // the destination grew past the anchor
    const rows = await loadAll();
    expect(rows.find((m) => m.ts === stray)!.content).toInclude("degraded"); // append intact
    expect(rows.find((m) => m.ts === ts)!.superseded_by).toBeUndefined(); // nothing half-published
    // Recovery is ordinary: with the contention gone, the batch lands and the
    // survivor stays.
    expect(await markManySuperseded(batch([ts]))).toBe(1);
    expect((await loadAll()).find((m) => m.ts === stray)).toBeDefined();
    h.release();
  });
});
