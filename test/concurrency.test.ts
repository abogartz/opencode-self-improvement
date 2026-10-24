// Two writers, one correction, interleaved. Daily store files are shared by
// every opencode session on the machine plus the viewer, which is a separate
// process. Appends are atomic on their own (O_APPEND), but supersede, prune and
// snapshot restore REWRITE a whole file: a writer that read before another's
// write publishes a stale copy and silently destroys the other's rows, and the
// truncate-then-write in between lets a reader observe a half file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoot } from "../src/config.ts";
import { appendMemory, loadAll, markSuperseded, prune, snapshotFiles } from "../src/memory.ts";
import { parseLine, readLines } from "../src/logfmt.ts";
import { restoreSnapshot } from "../src/undo.ts";

const DAY = new Date().toISOString().slice(0, 10);
const store = () => join(memoryRoot(), `${DAY}.logfmt`);
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-race-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(memoryRoot(), { recursive: true });
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function rawLines(): Promise<string[]> {
  return readLines(store());
}

/** Seed the daily file with `n` well-formed rows; returns their ts values. */
async function seed(n: number, scope = "seed"): Promise<string[]> {
  const base = Date.parse(`${DAY}T00:00:00.000Z`);
  const rows = Array.from(
    { length: n },
    (_, i) =>
      `ts=${new Date(base + i).toISOString()} type=learning scope=${scope} content="seed row ${i} ${"x".repeat(40)}"`,
  );
  writeFileSync(store(), `${rows.join("\n")}\n`);
  return rows.map((r) => r.slice(3, r.indexOf(" type=")));
}

describe("supersede racing appends", () => {
  test("no row is lost and every supersede lands", async () => {
    const seeded = await seed(40);
    const appends = Array.from({ length: 40 }, (_, i) =>
      appendMemory({ type: "pattern", scope: "racer", content: `appended ${i}` }),
    );
    const supersedes = seeded.map((ts) =>
      markSuperseded(ts, { superseded_by: "2026-01-02T00:00:00.000Z", reason: "drift" }),
    );
    const newTs = await Promise.all(appends);
    const marked = await Promise.all(supersedes);

    const lines = await rawLines();
    expect(marked.filter(Boolean)).toHaveLength(40);
    expect(lines).toHaveLength(80);
    for (const ts of newTs) expect(lines.some((l) => l.includes(`ts=${ts}`))).toBe(true);
    const rows = await loadAll();
    expect(rows.filter((m) => m.superseded_by)).toHaveLength(40);
    expect(rows).toHaveLength(80);
  });

  test("a concurrent reader never sees a half-written file", async () => {
    const seeded = await seed(300);
    let observedPartial = 0;
    let reads = 0;
    const reader = (async () => {
      for (let i = 0; i < 400; i++) {
        const lines = await rawLines();
        reads++;
        const malformed = lines.filter((l) => {
          const f = parseLine(l);
          return !f || typeof f.ts !== "string" || typeof f.content !== "string";
        });
        if (malformed.length) observedPartial++;
      }
    })();
    await Promise.all(
      seeded.map((ts) => markSuperseded(ts, { superseded_by: "2026-01-02T00:00:00.000Z", reason: "drift" })),
    );
    await reader;
    expect(reads).toBeGreaterThan(0);
    expect(observedPartial).toBe(0);
    expect(await rawLines()).toHaveLength(300);
  });
});

describe("prune racing appends", () => {
  test("rows appended while prune rewrites the file survive", async () => {
    await seed(30);
    const appends = Array.from({ length: 30 }, (_, i) =>
      appendMemory({ type: "pattern", scope: "keepme", content: `keep ${i}` }),
    );
    const forgotten = prune("seed", "learning", "cleanup");
    const newTs = await Promise.all(appends);
    const res = await forgotten;

    expect(res.deleted).toHaveLength(30);
    const lines = await rawLines();
    expect(lines).toHaveLength(30);
    for (const ts of newTs) expect(lines.some((l) => l.includes(`ts=${ts}`))).toBe(true);
  });
});

describe("restore racing appends", () => {
  test("a restore in flight does not lose a concurrent append", async () => {
    const seeded = await seed(20);
    const [snap] = await snapshotFiles([store()]);
    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendMemory({ type: "pattern", scope: "racer", content: `late ${i}` }),
      ),
    );
    const first = seeded[0] ?? "";
    const res = await Promise.all([
      restoreSnapshot(snap, memoryRoot(), "merge"),
      ...appended.map(() => markSuperseded(first, { superseded_by: "s", reason: "drift" })),
    ]);
    expect(res[0].restored).toBe(true);
    const lines = await rawLines();
    for (const ts of appended) expect(lines.some((l) => l.includes(`ts=${ts}`))).toBe(true);
  });

  test("a force restore under contention leaves no row in neither place", async () => {
    // Force drops rows by design. The contract is that none of them vanishes:
    // each row is either still in the store, in the safety snapshot the restore
    // took under the lock, or in the snapshot it restored from.
    const seeded = await seed(15);
    const [snap] = await snapshotFiles([store()]);
    const pending = Array.from({ length: 15 }, (_, i) =>
      appendMemory({ type: "pattern", scope: "racer", content: `late ${i}` }),
    );
    const res = await restoreSnapshot(snap, memoryRoot(), "force");
    const appended = await Promise.all(pending);

    const inStore = new Set((await rawLines()).map((l) => parseLine(l)?.ts));
    const safety = res.safety ? readFileSync(res.safety, "utf8") : "";
    const original = readFileSync(snap, "utf8");
    const lost = [...seeded, ...appended].filter(
      (ts) => !inStore.has(ts) && !safety.includes(ts) && !original.includes(ts),
    );
    expect(lost).toEqual([]);
  });
});

describe("two processes sharing one store", () => {
  const writer = join(import.meta.dir, "helpers", "writer.ts");

  async function spawn(n: number, supersede: string[]) {
    const p = Bun.spawn([process.execPath, writer, memoryRoot(), String(n), supersede.join(",")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await p.exited;
    return { code, err: await new Response(p.stderr).text() };
  }

  test("four writers: nothing is lost, every supersede lands, no lock is stranded", async () => {
    const seeded = await seed(20);
    const chunks = [seeded.slice(0, 5), seeded.slice(5, 10), seeded.slice(10, 15), seeded.slice(15, 20)];
    const runs = await Promise.all(chunks.map((c) => spawn(25, c)));
    // Anything non-zero carries its stderr into the failure message; a warning
    // unrelated to row loss must not fail a test about row loss.
    const failed = runs.filter((r) => r.code !== 0);
    expect(failed.map((r) => [r.code, r.err])).toEqual([]);

    const lines = await rawLines();
    expect(lines).toHaveLength(120);
    const tsValues = lines.map((l) => parseLine(l)?.ts as string);
    expect(new Set(tsValues).size).toBe(120); // no timestamp collisions across processes
    expect(lines.filter((l) => l.includes("superseded_by=stress"))).toHaveLength(20);
    expect(readdirSync(memoryRoot()).filter((f) => f.endsWith(".lock"))).toEqual([]);
  });

  test("a reader process always parses a complete file", async () => {
    await seed(200);
    const runs = Promise.all([spawn(50, []), spawn(50, []), spawn(50, [])]);
    let partial = 0;
    for (let i = 0; i < 300; i++) {
      const lines = await rawLines();
      if (lines.some((l) => !l.startsWith("ts=") || !l.includes(" content="))) partial++;
    }
    await runs;
    expect(partial).toBe(0);
    expect(await rawLines()).toHaveLength(350);
  });
});
