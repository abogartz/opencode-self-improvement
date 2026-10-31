// #196: a timed-out writer must not acknowledge a mutation that the current
// lock holder can overwrite. Handshakes fix the ordering; no slow-disk race.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemory, loadAll, markSuperseded } from "../src/memory.ts";
import { addBlock, blocklistFile } from "../src/blocklist.ts";
import { LOCK_WRITE, lockFileFor, withStoreLock } from "../src/lock.ts";
import { writeAtomic } from "../src/logfmt.ts";
import { resetSessionScopes, setRepoScope } from "../src/repokey.ts";
import { resetState } from "../src/state.ts";
import { rejectedFile, resetTombstoneCache, tombstoneMany, tombstones } from "../src/tombstones.ts";
import { contentHash } from "../src/evidence.ts";

let root: string;
const originalRoot = process.env.OPENCODE_MEMORY_DIR;
const originalBudget = LOCK_WRITE.timeoutMs;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-write-timeout-"));
  process.env.OPENCODE_MEMORY_DIR = root;
  resetState(); resetSessionScopes(); setRepoScope(null);
  resetTombstoneCache();
});
afterEach(() => {
  LOCK_WRITE.timeoutMs = originalBudget;
  resetState(); resetSessionScopes(); setRepoScope(null);
  if (originalRoot === undefined) delete process.env.OPENCODE_MEMORY_DIR;
  else process.env.OPENCODE_MEMORY_DIR = originalRoot;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function seed() {
  const ts = await appendMemory({ type: "learning", scope: "timeout", content: "the original row remains until an authorized mutation", repo: "global" });
  const row = (await loadAll()).find((row) => row.ts === ts);
  if (!row) throw new Error("seeded row missing");
  return { ts, file: row.file };
}

// Read before admitting the contender; publish that copy only after the
// contender reports its result. The old policy acknowledges a lost write.
async function holdRewrite(file: string) {
  const entered = deferred();
  const release = deferred();
  const held = withStoreLock(file, async () => {
    const before = readFileSync(file, "utf8");
    entered.resolve();
    await release.promise;
    await writeAtomic(file, before);
  }, LOCK_WRITE);
  await Promise.race([entered.promise, held.then(() => { throw new Error("holder never entered"); })]);
  return { held, release: release.resolve };
}

async function child(operation: string, ts: string): Promise<{ ok: boolean; error?: string }> {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "helpers/lock-timeout-writer.ts"), root, operation, ts], {
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  return JSON.parse(stdout);
}

test("a queued append refuses a busy store, preserves the holder, and succeeds on retry", async () => {
  const { file } = await seed();
  const before = readFileSync(file, "utf8");
  const h = await holdRewrite(file);
  const owner = readFileSync(lockFileFor(file), "utf8");
  const append = () => appendMemory({ type: "learning", scope: "timeout", content: "the queued row must survive an acknowledged append", repo: "global" });
  LOCK_WRITE.timeoutMs = 40;
  try {
    await expect(append()).rejects.toThrow(/memory store is busy:.*retry/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readFileSync(lockFileFor(file), "utf8")).toBe(owner);
  } finally {
    h.release();
    await h.held;
  }
  expect(readFileSync(file, "utf8")).toBe(before);
  const ts = await append();
  expect((await loadAll()).map((row) => row.ts)).toContain(ts);
  expect(await loadAll()).toHaveLength(2);
}, 15_000);

test.each(["append", "prune", "supersede", "batch", "clear", "delete", "block", "unblock", "tombstone", "unreject"])(
  "a separate-process %s refuses the held file; no false success, and retry lands",
  async (operation) => {
    const seeded = await seed();
    if (operation === "clear") await markSuperseded(seeded.ts, { superseded_by: "old", reason: "fixture" });
    const isBlock = operation === "block" || operation === "unblock";
    if (isBlock) await addBlock(seeded.ts, "fixture");
    const isRejection = operation === "tombstone" || operation === "unreject";
    if (isRejection) await tombstoneMany([
      { content: "existing value rejected by human" },
      { content: "unrelated rejection must survive" },
    ], { reason: "fixture", source: "test" });
    const file = isRejection ? rejectedFile() : isBlock ? blocklistFile() : seeded.file;
    const before = readFileSync(file, "utf8");
    const h = await holdRewrite(file);
    const owner = readFileSync(lockFileFor(file), "utf8");
    try {
      const result = await child(operation, seeded.ts);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/memory store is busy:.*retry/);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(readFileSync(lockFileFor(file), "utf8")).toBe(owner);
    } finally {
      h.release();
      await h.held;
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect((await child(operation, seeded.ts)).ok).toBe(true);
    expect(readFileSync(file, "utf8")).not.toBe(before);
    if (operation === "append") {
      expect((await loadAll()).map((row) => row.content)).toContain("the child row must survive an acknowledged append");
      expect(await loadAll()).toHaveLength(2);
    }
    if (isRejection) {
      const expected = operation === "tombstone"
        ? ["existing value rejected by human", "unrelated rejection must survive", "newly rejected value"]
        : ["unrelated rejection must survive"];
      expect((await tombstones()).map((row) => row.ch).sort()).toEqual(expected.map(contentHash).sort());
    }
  }, 15_000,
);
