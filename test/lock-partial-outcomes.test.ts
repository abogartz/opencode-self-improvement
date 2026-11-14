import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as evidence from "../src/evidence/record.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  canonicalFile,
  deletionsFile,
  evidenceDir,
  memoryRoot,
} from "../src/core/config/paths.ts";
import { dateStr } from "../src/core/time.ts";
import { formatLine, parseLine } from "../src/core/logfmt/format.ts";
import * as publishModule from "../src/core/logfmt/publish.ts";
import { loadAll } from "../src/store/files/load.ts";
import * as deletionsModule from "../src/store/files/deletions.ts";
import { snapshotFiles } from "../src/store/files/snapshots.ts";
import { markManySupersededReport } from "../src/store/files/supersede.ts";
import { pruneMemory } from "../src/store/prune.ts";
import * as tombstoneModule from "../src/store/tombstones/tombstone.ts";
import { contentHash } from "../src/evidence/record.ts";
import {
  LOCK_RESTORE,
  LOCK_WRITE,
  setLockBusyInjector,
  withStoreLock,
} from "../src/store/lock.ts";
import { restoreSnapshot } from "../src/store/undo.ts";
import { editMemory } from "../src/viewer/mutate.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { lockIdentity } from "./helpers/lock-identity.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
let plugins: LoadedPlugin[];
const writeBudget = LOCK_WRITE.timeoutMs;
const restoreBudget = LOCK_RESTORE.timeoutMs;
const first = "2026-01-01T00:00:00.000Z";
const second = "2026-01-02T00:00:00.000Z";
const path = (ts: string) => join(memoryRoot(), `${ts.slice(0, 10)}.logfmt`);
const record = evidence.record;
const pendingEvidence = new Set<Promise<void>>();
let evidenceErrors: unknown[];
let restoreEvidence = () => {};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-partial-lock-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(memoryRoot(), { recursive: true });
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  resetCaptureCooldowns();
  LOCK_WRITE.timeoutMs = 40;
  LOCK_RESTORE.timeoutMs = 40;
  plugins = [];
  evidenceErrors = [];
  // Lock telemetry is fire-and-forget. Keep the real writer and its errors,
  // but own its lifetime so deleting this fixture cannot break the next test.
  const spy = spyOn(evidence, "record").mockImplementation(
    (...args: Parameters<typeof record>) => {
      const write = record(...args);
      const settled = write.then(
        () => {},
        (error: unknown) => {
          evidenceErrors.push(error);
        },
      );
      pendingEvidence.add(settled);
      void settled.then(() => pendingEvidence.delete(settled));
      return write;
    },
  );
  restoreEvidence = () => spy.mockRestore();
}, 30_000);
afterEach(async () => {
  for (const plugin of plugins) await plugin.cleanup();
  while (pendingEvidence.size) await Promise.all(pendingEvidence);
  restoreEvidence();
  LOCK_WRITE.timeoutMs = writeBudget;
  LOCK_RESTORE.timeoutMs = restoreBudget;
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
  expect(evidenceErrors).toEqual([]);
}, 30_000);
function seed(ts: string, content: string) {
  writeFileSync(
    path(ts),
    formatLine({
      ts,
      type: "context",
      scope: "planning",
      content,
      status: "open",
      repo: "global",
    }) + "\n",
  );
}
async function plugin() {
  const p = await loadPlugin(root);
  plugins.push(p);
  return p;
}
/**
 * Run `run` with acquisitions of `file` refused, as if another writer held it.
 *
 * This used to hold a real in-process lock on `file`, which worked when each day
 * file had its own lock. The lock is per store directory now (#407), so holding
 * one day file holds every one of them and the batch under test could never
 * reach the second file it is supposed to lose. The refusal is injected at the
 * acquisition instead — same timeout policy, same busy message — and the real
 * cross-process case is pinned in lock.test.ts.
 */
async function held(file: string, run: () => Promise<void>) {
  // Warm the lock artifact first: the identity below has to be captured against
  // an existing database, not "absent".
  await withStoreLock(file, async () => undefined, LOCK_WRITE);
  const owner = lockIdentity(file);
  setLockBusyInjector((target) => target === file);
  try {
    await run();
    expect(lockIdentity(file)).toBe(owner);
  } finally {
    setLockBusyInjector();
  }
}

const ctx = { sessionID: "partial-lock", id: "partial-lock-call" };

// A starved ubuntu/Windows --parallel=4 worker can spend real time past Bun's
// default 5s budget inside one of these held-file scenarios; the test dies
// mid-flight, afterEach deletes the fixture underneath the still-pending work,
// and the leftovers surface as "Unhandled error between tests" plus false
// assertion failures in the tests beside it (measured on run 41356328156: a
// snapshotFiles ENOENT after teardown, an escaped busy error, and a
// superseded_by read that came back undefined). Bun applies the default 5s to
// hooks even where the test carries a longer override, so every test AND hook
// here gets an explicit 30s budget. No assertion moves; only time is granted
// (#245, following d38e6a7).
test("a batch retains the first file's durable receipt when the next file is busy", async () => {
  seed(first, "first row");
  seed(second, "second row");
  const durable: string[] = [];
  const before = readFileSync(path(second), "utf8");
  await held(path(second), async () => {
    await expect(
      markManySupersededReport(
        [first, second].map((ts) => ({
          ts,
          fields: { superseded_by: "survivor", reason: "probe" },
        })),
        durable,
      ),
    ).rejects.toThrow(basename(path(second)));
    expect(durable).toEqual([first]);
    expect(
      (await loadAll()).find((row) => row.ts === first)?.superseded_by,
    ).toBe("survivor");
    expect(readFileSync(path(second), "utf8")).toBe(before);
  });
  const retry: string[] = [];
  expect(
    (
      await markManySupersededReport(
        [first, second].map((ts) => ({
          ts,
          fields: { superseded_by: "survivor", reason: "probe" },
        })),
        retry,
      )
    ).marked,
  ).toEqual([second]);
  expect(retry).toEqual([second]);
  expect(durable).toEqual([first]);
}, 30_000);

test("refusal at the first file has no durable receipts and merge reports no mutation", async () => {
  seed(first, "loser row");
  seed(second, "survivor row");
  const p = await plugin();
  const before = [
    readFileSync(path(first), "utf8"),
    readFileSync(path(second), "utf8"),
  ];
  const durable: string[] = [];
  await held(path(first), async () => {
    await expect(
      markManySupersededReport(
        [{ ts: first, fields: { superseded_by: second, reason: "probe" } }],
        durable,
      ),
    ).rejects.toThrow(/busy/);
    expect(durable).toEqual([]);
    const out = await p.tools.memory_merge_review.execute(
      { loser: first, survivor: second, reason: "chosen by human" },
      ctx,
    );
    expect(out.content).toContain("nothing was done");
    expect(out.content).not.toContain("PARTIAL");
    expect(out.content).toContain(basename(path(first)));
    expect([
      readFileSync(path(first), "utf8"),
      readFileSync(path(second), "utf8"),
    ]).toEqual(before);
  });
}, 30_000);

test("merge_review reports the retirement already published before a later timeout", async () => {
  seed(first, "loser row");
  seed(second, "survivor row");
  const p = await plugin();
  await held(path(second), async () => {
    const out = await p.tools.memory_merge_review.execute(
      { loser: first, survivor: second, reason: "chosen by human" },
      ctx,
    );
    expect(
      (await loadAll()).find((row) => row.ts === first)?.superseded_by,
    ).toBe(second);
    expect(out.content).toContain("PARTIAL");
    expect(out.content).toContain(first);
    expect(out.content).toContain(basename(path(second)));
    expect(out.content).not.toContain("nothing was done");
  });
}, 30_000);

test("canonical update retains the gate's completed retirement on a later busy file", async () => {
  seed(first, "worker backend mysql");
  seed(second, "queue backend redis");
  writeFileSync(
    canonicalFile(),
    formatLine({
      ts: first,
      type: "canonical",
      scope: "planning",
      entity: "backend",
      value: "postgres",
      source: "fixture",
    }) + "\n",
  );
  const p = await plugin();
  await held(path(second), async () => {
    const out = await p.tools.memory_update.execute(
      {
        type: "context",
        scope: "planning",
        query: second,
        content: "queue backend postgres",
      },
      ctx,
    );
    expect(
      (await loadAll()).find((row) => row.ts === first)?.superseded_by,
    ).toBeDefined();
    expect(out.content).not.toContain("Nothing was written");
    expect(out.content).toContain(first);
    expect(out.content).toContain(basename(path(second)));
    expect(
      (await loadAll()).find((row) => row.ts === second)?.superseded_by,
    ).toBeUndefined();
  });
}, 30_000);

test("restore uses its real fail-closed policy and preserves the held file", async () => {
  seed(first, "snapshot row");
  const [snapshot] = await snapshotFiles([path(first)]);
  seed(first, "current row must survive refusal");
  const before = readFileSync(path(first), "utf8");
  await held(path(first), async () => {
    await expect(
      restoreSnapshot(snapshot, memoryRoot(), "force"),
    ).rejects.toThrow(/busy/);
    expect(readFileSync(path(first), "utf8")).toBe(before);
  });
  expect(
    (await restoreSnapshot(snapshot, memoryRoot(), "force")).restored,
  ).toBe(true);
  expect((await loadAll())[0].content).toBe("snapshot row");
}, 30_000);

test("viewer edit names the durable replacement when retiring its original is refused", async () => {
  seed(first, "original viewer row");
  await held(path(first), async () => {
    let error = "";
    try {
      await editMemory({
        ts: first,
        type: "context",
        scope: "planning",
        content: "edited viewer row",
        reason: "human correction",
      });
    } catch (err) {
      error = String(err);
    }
    const rows = await loadAll();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.superseded_by)).toBe(true);
    const replacement = rows.find((row) => row.content === "edited viewer row");
    expect(replacement).toBeDefined();
    expect(error).toContain("PARTIAL");
    if (!replacement) throw new Error("viewer replacement missing");
    expect(error).toContain(replacement.ts);
    expect(error).toContain(first);
  });
}, 30_000);

test.each(["memory_forget", "memory_decay"])(
  "%s reports and audits the rows published before a later timeout",
  async (tool) => {
    seed(first, "first planned task");
    seed(second, "second planned task");
    const p = await plugin();
    await held(path(second), async () => {
      const args =
        tool === "memory_forget"
          ? { scope: "planning", type: "context", reason: "human cleanup" }
          : { days: 1, dryRun: false };
      const out = await p.tools[tool].execute(args, ctx);
      expect(out.content).toContain("PARTIAL");
      expect(out.content).toContain(first);
      expect(out.content).toContain(basename(path(second)));
      const evidence = readFileSync(
        join(evidenceDir(), `${dateStr()}.logfmt`),
        "utf8",
      )
        .split("\n")
        .map(parseLine);
      const receipt = evidence.find(
        (row) =>
          row?.ev === (tool === "memory_forget" ? "prune" : "decay_applied"),
      );
      expect(receipt?.partial).toBe("true");
      expect(receipt?.mem).toBe(first);
      const rows = await loadAll();
      expect(
        rows.find((row) => row.ts === second)?.superseded_by,
      ).toBeUndefined();
      if (tool === "memory_forget") {
        expect(rows.map((row) => row.ts)).toEqual([second]);
        // #206 STORE-1: the row the forget already published must stay
        // rejected even though a later file timed out — the rows are gone,
        // so a retry can never tombstone them.
        const chs = (await tombstoneModule.tombstones()).map((t) => t.ch);
        expect(chs).toContain(contentHash("first planned task"));
        expect(chs).not.toContain(contentHash("second planned task"));
      } else
        expect(rows.find((row) => row.ts === first)?.superseded_by).toBe(
          "decay",
        );
    });
  },
  30_000,
);

// #206 STORE-2: prune audited every deletion BEFORE republishing the file, so
// a snapshot/publish failure left `action=deleted` lines for rows still on
// disk — the viewer's Deleted panel listed a live row, restore-entry would
// duplicate it, and undo treated the ts as intentionally removed. The audit
// now follows the publish, matching the viewer's delete.
test("a failed publish leaves no phantom deletion audit", async () => {
  seed(first, "prune publish target");
  const spy = spyOn(publishModule, "writeAtomic").mockRejectedValue(
    Object.assign(new Error("EPERM: operation not permitted, rename"), {
      code: "EPERM",
    }),
  );
  let message = "";
  try {
    await pruneMemory("planning", "context", "probe reason");
    message = "pruneMemory resolved; expected the publish failure to throw";
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  } finally {
    spy.mockRestore();
  }
  expect(message).toContain("EPERM");
  expect((await loadAll()).map((row) => row.content)).toEqual([
    "prune publish target",
  ]);
  let audit = "";
  try {
    audit = readFileSync(deletionsFile(), "utf8");
  } catch {
    // no audit file at all is the correct shape
  }
  expect(audit).not.toContain("action=deleted");
}, 30_000);

// #206: failure of the bookkeeping writes themselves must be explicit, not
// silent. An audit append failing after a committed publish keeps the row
// deleted, still tombstones the value, and reports PARTIAL naming the audit.
test("a failed deletion audit keeps the tombstone and reports PARTIAL", async () => {
  seed(first, "audited then tombstoned");
  const spy = spyOn(deletionsModule, "logDeletion").mockRejectedValue(
    new Error("EPERM: audit append denied"),
  );
  const res = await pruneMemory("planning", "context", "probe reason").finally(
    () => spy.mockRestore(),
  );
  expect(res.error).toContain("deletion audit failed");
  expect(res.deleted.map((d) => d.memory.content)).toEqual([
    "audited then tombstoned",
  ]);
  expect(await loadAll()).toEqual([]);
  expect((await tombstoneModule.tombstones()).map((t) => t.ch)).toContain(
    contentHash("audited then tombstoned"),
  );
}, 30_000);

// The tombstone append failing after a committed publish is the residual the
// PARTIAL reply must name: the rows are gone and unprotected, liftable only
// by a human reject in the viewer. The audit line is truthful here — the
// publish did land.
test("a failed tombstone append is reported and the audit stays truthful", async () => {
  seed(first, "tombstone write fails");
  const spy = spyOn(tombstoneModule, "tombstoneMany").mockRejectedValue(
    new Error("EACCES: rejected.logfmt append denied"),
  );
  const res = await pruneMemory("planning", "context", "probe reason").finally(
    () => spy.mockRestore(),
  );
  expect(res.error).toContain("rejection tombstones incomplete");
  expect(res.error).toContain("EACCES");
  expect(res.deleted).toHaveLength(1);
  expect(await loadAll()).toEqual([]);
  const audit = readFileSync(deletionsFile(), "utf8");
  expect(audit).toContain("action=deleted");
  expect(audit).toContain(`original_ts=${first}`);
}, 30_000);

// #206: both errors survive together — the primary (busy file) and the
// secondary (tombstone append) each appear in the PARTIAL error, so the
// reply never hides one behind the other.
test("a busy later file and a failed tombstone append both surface", async () => {
  seed(first, "primary and secondary");
  seed(second, "busy row");
  const spy = spyOn(tombstoneModule, "tombstoneMany").mockRejectedValue(
    new Error("EACCES: rejected.logfmt append denied"),
  );
  try {
    await held(path(second), async () => {
      const res = await pruneMemory("planning", "context", "probe reason");
      expect(res.error).toContain(basename(path(second)));
      expect(res.error).toContain("rejection tombstones incomplete");
      expect((await loadAll()).map((row) => row.ts)).toEqual([second]);
    });
  } finally {
    spy.mockRestore();
  }
}, 30_000);

test("capture records each busy refusal and still records lag", async () => {
  const today = `${dateStr()}T00:00:00.000Z`;
  seed(today, "unrelated existing row");
  const p = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugins.push(p);
  await p["tool.execute.after"](
    {
      tool: "read",
      sessionID: "capture-busy",
      callID: "C1",
      args: { filePath: "x.ts" },
    },
    { title: "read", output: "content", metadata: {} },
  );
  p.capture.generate.response = JSON.stringify([
    {
      type: "learning",
      scope: "archive",
      content:
        "The nightly archive job runs at 02:30 UTC and keeps fourteen days of tarballs",
    },
    {
      type: "learning",
      scope: "build",
      content:
        "Run bun test from the repository root to execute the test suite",
    },
  ]);
  const before = readFileSync(path(today), "utf8");
  await held(path(today), async () => {
    await p.sessionHooks["compaction"]?.({
      sessionID: "capture-busy",
      system: [],
      messages: [
        {
          role: "user",
          content:
            "The nightly archive job runs at 02:30 UTC and keeps fourteen days of tarballs for restore drills. Run bun test from the repository root to execute the test suite. Keep both operational notes in the project runbook for future sessions and reviews.",
        },
      ],
    });
    const deadline = Date.now() + 3000;
    while (
      !readFileSync(
        join(evidenceDir(), `${dateStr()}.logfmt`),
        "utf8",
      ).includes("ev=capture_lag")
    ) {
      if (Date.now() >= deadline)
        throw new Error("capture did not finish or record lag");
      await Bun.sleep(5);
    }
    const lines = readFileSync(
      join(evidenceDir(), `${dateStr()}.logfmt`),
      "utf8",
    )
      .split("\n")
      .map(parseLine);
    const refused = lines.filter((row) => row?.ev === "auto_capture_refused");
    expect(refused).toHaveLength(2);
    expect(refused.map((row) => row?.scope).sort()).toEqual([
      "archive",
      "build",
    ]);
    expect(refused.every((row) => String(row?.reason).includes("busy"))).toBe(
      true,
    );
    expect(lines.filter((row) => row?.ev === "capture_lag")).toHaveLength(1);
    expect(readFileSync(path(today), "utf8")).toBe(before);
  });
}, 30_000);
