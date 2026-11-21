// The use ledger at unit altitude. e2e/ledger.test.ts proves the wiring
// through a real host; this file pins the module's own promises — the line
// shape, the throttle and its keys, the ring's rotation, what may and may not
// be written into `terms`, what the ledger can honestly claim about rows it
// has never seen, and the qualifier the surfaces must carry when the ledger
// is too young to call anything "never retrieved".
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markTurn } from "../../src/capture/triggers.ts";
import { memoryRoot } from "../../src/core/config/paths.ts";
import { SESSION_CAP } from "../../src/core/lru.ts";
import { peekTurn } from "../../src/core/state.ts";
import { scoreMemories, words } from "../../src/recall/score.ts";
import { sharedTerms } from "../../src/recall/shared-terms.ts";
import { ledgerIsYoung } from "../../src/status/metrics.ts";
import { renderMemoryReport } from "../../src/status/report.ts";
import {
  EVICT_MIN_RIDES,
  summarizeStore,
} from "../../src/status/store-summary.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import { loadAll } from "../../src/store/files/load.ts";
import {
  lockDatabaseFor,
  LOCK_WRITE,
  withStoreLock,
} from "../../src/store/lock.ts";
import type { Memory } from "../../src/store/model/memory.ts";
import {
  getDroppedOutcomeWrites,
  HITS_FILENAME,
  hitsFile,
  joinUseWithOutcomes,
  neverRetrieved,
  RETRY_BACKOFF_MS,
  readLedger,
  readOutcomes,
  readRides,
  recordHits,
  recordOutcome,
  resetHitThrottle,
  resetLedgerCache,
  THROTTLE_MS,
  usedRecently,
  useSignals,
} from "../../src/telemetry/ledger.ts";
import { childHolder } from "../helpers/hold-cross-process.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-hits-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  mkdirSync(memoryRoot(), { recursive: true });
  resetHitThrottle();
  resetLedgerCache();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

const ledgerText = () => readFileSync(hitsFile(), "utf8");
const row = (ts: string): Memory =>
  ({
    ts,
    type: "learning",
    scope: "s",
    content: `fact at ${ts}`,
    file: "x.logfmt",
    index: 0,
  }) as Memory;

describe("the ledger line", () => {
  test("one exact line per source, with the rows credited and the terms they shared", async () => {
    const hit = await recordHits(
      "pull",
      "ses-1",
      [row("2026-01-01T00:00:00.000Z")],
      ["build"],
      Date.parse("2026-06-01T00:00:00Z"),
    );
    expect(hit).toBe(true);
    const line = ledgerText().trim();
    expect(line).toInclude("ev=memory_used");
    expect(line).toInclude("ts=2026-06-01T00:00:00.000Z");
    expect(line).toInclude("src=pull");
    expect(line).toInclude("sid=ses-1");
    expect(line).toInclude("2026-01-01T00:00:00.000Z");
    expect(line).toInclude("build");

    const ledger = await readLedger();
    expect(ledger.byRow.get("2026-01-01T00:00:00.000Z")).toEqual({
      count: 1,
      last: "2026-06-01T00:00:00.000Z",
      terms: ["build"],
    });
    expect(ledger.since).toBe("2026-06-01T00:00:00.000Z");
    expect(ledger.lines).toBe(1);
  });

  test("a timed-out pull preserves the queue for pending and later gate writers", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withStoreLock(hitsFile(), async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const now = Date.now();
    const pull = recordHits("pull", "s", [row("one")], [], now, 1, "turn", {
      lockWaitMs: 50,
      observedAt: now,
    });
    const waiting = recordOutcome("s", 1, "PASS", "first");
    const saved = await pull;
    const arriving = recordOutcome("s", 2, "PASS", "second");
    release.resolve();
    await holder;
    expect(saved).toBe(false);
    expect(await Promise.all([waiting, arriving])).toEqual([true, true]);
    expect((await readOutcomes()).map((outcome) => outcome.cmd)).toEqual([
      "first",
      "second",
    ]);
    expect(getDroppedOutcomeWrites()).toBe(0);
  });

  test("a cold ledger lock respects the receipt budget during legacy journal conversion", async () => {
    const db = new Database(lockDatabaseFor(hitsFile()));
    const rows = [row("2026-01-01T00:00:00.000Z")];
    const receipt = (sid: string) =>
      recordHits("pull", sid, rows, [], Date.now(), 1, "turn", {
        lockWaitMs: 50,
        observedAt: Date.now(),
      });
    try {
      db.run("PRAGMA journal_mode = WAL");
      db.run("BEGIN IMMEDIATE");
      const start = performance.now();
      expect(await receipt("held")).toBe(false);
      expect(performance.now() - start).toBeLessThan(1000);
      expect((await readRides()).length).toBe(0);
    } finally {
      db.close();
    }
    expect(await receipt("released")).toBe(true);
    expect((await readRides()).map((ride) => ride.sid)).toEqual(["released"]);
  });

  test("an empty row-set is not a use, and terms are capped", async () => {
    expect(await recordHits("inject", "s", [], ["x"])).toBe(false);
    const many = Array.from({ length: 12 }, (_, i) => `term${i}`);
    await recordHits("recall", "s", [row("2026-01-01T00:00:00.000Z")], many);
    const ledger = await readLedger();
    expect(ledger.byRow.get("2026-01-01T00:00:00.000Z")?.terms).toHaveLength(8);
  });

  test("terms can only ever be words the row itself contains", () => {
    // The privacy guarantee: the ledger stores no prompt text. What it
    // stores is the INTERSECTION of query words and the row's own vocabulary,
    // so every logged term already exists inside the row it points at.
    const m: Memory = {
      ts: "2026-01-01T00:00:00.000Z",
      type: "learning",
      scope: "deploys",
      content: "staging deploys run make deploy-staging after the vpn is up",
    } as Memory;
    const query =
      "how do we promote to staging after the vpn, plus zzzqqq private prompt phrase";
    const terms = sharedTerms(query, m);
    const vocab = new Set(words(`${m.scope} ${m.type} ${m.content}`));
    expect(terms.length).toBeGreaterThan(0);
    for (const t of terms) expect(vocab.has(t)).toBe(true);
    expect(terms).not.toInclude("zzzqqq");
    expect(terms).not.toInclude("private");
    expect(terms).not.toInclude("phrase");
  });
});

describe("the throttle", () => {
  test("observing a delayed pull changes the ride timestamp but preserves the placement throttle", async () => {
    const t = Date.parse("2026-11-21T12:00:00.000Z");
    const rows = [row("2026-11-20T10:00:00Z")];
    const receipt = (placed: number, observed: number) =>
      recordHits("pull", "delayed", rows, [], placed, 1, "turn", {
        lockWaitMs: 50,
        observedAt: observed,
      });
    expect(await receipt(t, t + 600_000)).toBe(true);
    expect(await receipt(t + 3_599_999, t + 4_100_000)).toBe(false);
    expect(await receipt(t + 3_600_001, t + 4_100_001)).toBe(true);
    expect((await readRides()).map((ride) => ride.ts)).toEqual([
      new Date(t + 600_000).toISOString(),
      new Date(t + 4_100_001).toISOString(),
    ]);
  });

  test("a filesystem lock refusal backs off repeated calls, then permits another attempt", async () => {
    const t0 = Date.parse("2026-06-01T00:00:00Z");
    const rows = [row("2026-01-01T00:00:00.000Z")];
    const originalBudget = LOCK_WRITE.timeoutMs;
    const originalEvent = LOCK_WRITE.onEvent;
    const events: string[] = [];
    // No in-process holder: this forces the cross-process wait, which is what
    //throttles. A live rival process is the only honest fixture now —
    // the lock is a kernel record, not a file a test can create by hand.
    const holder = await childHolder(hitsFile());
    LOCK_WRITE.timeoutMs = 40;
    LOCK_WRITE.onEvent = (event) => {
      events.push(event);
    };
    try {
      expect(await recordHits("recall", "ses", rows, [], t0)).toBe(false);
      for (const delta of [1, 2, RETRY_BACKOFF_MS - 1]) {
        expect(await recordHits("recall", "ses", rows, [], t0 + delta)).toBe(
          false,
        );
      }
      // Counting lock attempts avoids a machine-speed-dependent latency test.
      expect(events).toEqual(["timeout"]);
      expect(
        await recordHits("recall", "ses", rows, [], t0 + RETRY_BACKOFF_MS),
      ).toBe(false);
      expect(events).toEqual(["timeout", "timeout"]);
      expect((await readLedger()).lines).toBe(0);
    } finally {
      LOCK_WRITE.timeoutMs = originalBudget;
      LOCK_WRITE.onEvent = originalEvent;
      await holder.release();
    }
    expect(
      await recordHits(
        "recall",
        "ses",
        rows,
        [],
        t0 + 2 * RETRY_BACKOFF_MS - 1,
      ),
    ).toBe(false);
    expect(
      await recordHits("recall", "ses", rows, [], t0 + 2 * RETRY_BACKOFF_MS),
    ).toBe(true);
    expect((await readLedger()).lines).toBe(1);
  }, 30_000);

  test("reset refuses active writes rather than clearing their duplicate guard", async () => {
    const rows = [row("2026-01-01T00:00:00.000Z")];
    const pending = recordHits("recall", "ses", rows);
    try {
      expect(() => resetHitThrottle()).toThrow(
        "await pending recordHits calls",
      );
      expect(await recordHits("recall", "ses", rows)).toBe(false);
    } finally {
      await pending;
    }
    expect((await readLedger()).lines).toBe(1);
    resetHitThrottle();
    expect(await recordHits("recall", "ses", rows)).toBe(true);
    expect((await readLedger()).lines).toBe(2);
  });

  test("a refused lock does not throttle the retry after the holder releases", async () => {
    const t0 = Date.parse("2026-06-01T00:00:00Z");
    const rows = [row("2026-01-01T00:00:00.000Z")];
    const originalBudget = LOCK_WRITE.timeoutMs;
    const originalEvent = LOCK_WRITE.onEvent;
    const events: string[] = [];
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withStoreLock(
      hitsFile(),
      async () => {
        enter();
        await released;
      },
      { onTimeout: "fail" },
    );
    try {
      await Promise.race([
        entered,
        holder.then(() => {
          throw new Error("holder never entered");
        }),
      ]);
      LOCK_WRITE.timeoutMs = 40;
      // Capture the refusal directly rather than leave fire-and-forget lock
      // evidence writing into a temporary store during fixture teardown.
      LOCK_WRITE.onEvent = (event) => {
        events.push(event);
      };
      expect(await recordHits("recall", "ses", rows, [], t0)).toBe(false);
      expect(events).toEqual(["timeout"]);
      expect((await readLedger()).lines).toBe(0);
    } finally {
      LOCK_WRITE.timeoutMs = originalBudget;
      LOCK_WRITE.onEvent = originalEvent;
      release();
      await holder;
    }
    expect(
      await recordHits("recall", "ses", rows, [], t0 + RETRY_BACKOFF_MS - 1),
    ).toBe(false);
    expect(
      await recordHits("recall", "ses", rows, [], t0 + RETRY_BACKOFF_MS),
    ).toBe(true);
    expect(
      await recordHits("recall", "ses", rows, [], t0 + RETRY_BACKOFF_MS),
    ).toBe(false);
    expect((await readLedger()).lines).toBe(1);
  }, 30_000);

  test("an append failure stays fail-soft and allows retry once the file is writable", async () => {
    const t0 = Date.parse("2026-06-01T00:00:00Z");
    const memory = row("2026-01-01T00:00:00.000Z");
    const rows = [memory];
    // The sibling lock can be acquired, but a directory cannot be appended
    // to as a ledger. This exercises an I/O failure after lock acquisition.
    mkdirSync(hitsFile());
    expect(await recordHits("pull", "ses", rows, [], t0)).toBe(false);
    rmdirSync(hitsFile());
    expect(
      await recordHits("pull", "ses", rows, [], t0 + RETRY_BACKOFF_MS - 1),
    ).toBe(false);
    expect(
      await recordHits("pull", "ses", rows, [], t0 + RETRY_BACKOFF_MS),
    ).toBe(true);
    expect(
      await recordHits("pull", "ses", rows, [], t0 + RETRY_BACKOFF_MS),
    ).toBe(false);
    expect((await readLedger()).byRow.get(memory.ts)?.count).toBe(1);
  });

  test("overlapping identical calls persist one use, then normal expiry permits another", async () => {
    const t0 = Date.parse("2026-06-01T00:00:00Z");
    const memory = row("2026-01-01T00:00:00.000Z");
    const rows = [memory];
    // Start every call before any async filesystem operation can finish.
    // Setting the cooldown after the await without an in-flight guard must
    // fail this assertion: file locking alone serializes duplicate appends.
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        recordHits("inject", "ses", rows, [], t0),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await readLedger()).byRow.get(memory.ts)?.count).toBe(1);
    expect(
      await recordHits("inject", "ses", rows, [], t0 + THROTTLE_MS - 1),
    ).toBe(false);
    expect(await recordHits("inject", "ses", rows, [], t0 + THROTTLE_MS)).toBe(
      true,
    );
    expect((await readLedger()).byRow.get(memory.ts)?.count).toBe(2);
  });

  test("a repeat within the window adds nothing; after it, the use counts again", async () => {
    const t0 = Date.parse("2026-06-01T00:00:00Z");
    const rows = [row("2026-01-01T00:00:00.000Z")];
    expect(await recordHits("inject", "ses", rows, ["a"], t0)).toBe(true);
    expect(
      await recordHits("inject", "ses", rows, ["a"], t0 + THROTTLE_MS - 1),
    ).toBe(false);
    expect(
      await recordHits("inject", "ses", rows, ["a"], t0 + THROTTLE_MS),
    ).toBe(true);
    expect(await readLedger()).toEqual(await readLedger()); // still parseable
    expect((await readLedger()).lines).toBe(2);
  });

  test("the throttle key is (source, session, row-set) — each axis varies freely", async () => {
    const t0 = Date.parse("2026-06-01T00:00:00Z");
    const rows = [row("2026-01-01T00:00:00.000Z")];
    expect(await recordHits("inject", "ses", rows, [], t0)).toBe(true);
    expect(await recordHits("recall", "ses", rows, [], t0)).toBe(true); // other source
    expect(await recordHits("inject", "other", rows, [], t0)).toBe(true); // other session
    expect(
      await recordHits(
        "inject",
        "ses",
        [row("2026-01-02T00:00:00.000Z")],
        [],
        t0,
      ),
    ).toBe(true); // other rows
    expect((await readLedger()).lines).toBe(4);
  });
});

describe("the ring", () => {
  test("over the size cap the older half is dropped whole-line and the newest survives", async () => {
    // ~2.4 MB of filler first lines, oldest on top; then one real hit.
    const filler = Array.from(
      { length: 40_000 },
      (_, i) =>
        `ev=memory_used ts=2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z filler=${i}`,
    );
    writeFileSync(hitsFile(), filler.join("\n") + "\n");
    expect(filler.join("\n").length).toBeGreaterThan(2_000_000);
    await recordHits(
      "inject",
      "ses",
      [row("2026-01-01T00:00:00.000Z")],
      ["keep"],
    );
    const lines = ledgerText().trim().split("\n");
    expect(lines[lines.length - 1]).toInclude("keep");
    expect(lines.length).toBeLessThan(filler.length + 1);
    expect(lines.some((l) => l.includes("filler=0"))).toBe(false); // the old head is gone
  });
});

describe("use signals and the honest window", () => {
  test("a re-ingested row cannot inherit the reinforcement of the row that held its words", async () => {
    // The ledger keys by row ts. Prune the row, write the same content again:
    // new ts, no credit — old hits belong to the retired identity.
    await appendMemory({
      type: "learning",
      scope: "rev",
      content: "the vault rotates on the first monday",
    });
    const [original] = await loadAll();
    await recordHits("recall", "s", [original!], ["vault"]);
    const ledger = await readLedger();
    expect(ledger.byRow.get(original!.ts)?.count).toBe(1);

    // "Prune" (delete the day file) and re-capture the same fact.
    removeStore(memoryRoot());
    mkdirSync(memoryRoot(), { recursive: true });
    resetLedgerCache();
    // appendMemory stamps `ts` from the wall clock at millisecond resolution
    // and only bumps it when that ts is ALREADY in the day file. This test
    // deletes the store between the two writes, so nothing forces the second
    // stamp forward: both rows land in the same millisecond whenever the prune
    // is fast enough, and the identity difference under test becomes luck.
    // Cross the millisecond boundary so the new ts is genuinely new.
    const stampMs = Date.now();
    while (Date.now() === stampMs) {
      // spin
    }
    await appendMemory({
      type: "learning",
      scope: "rev",
      content: "the vault rotates on the first monday",
    });
    const [fresh] = await loadAll();
    expect(fresh!.ts).not.toBe(original!.ts);
    const signals = await useSignals();
    expect(signals.get(fresh!.ts)).toBeUndefined(); // credit denied to the new identity
  });

  test("neverRetrieved covers no-use AND stale-use; usedRecently counts the other side", async () => {
    const fresh = row("2026-01-01T00:00:00.000Z");
    const stale = row("2026-01-02T00:00:00.000Z");
    const dead = row("2026-01-03T00:00:00.000Z");
    const never = row("2026-01-04T00:00:00.000Z");
    const now = Date.now();
    await recordHits("recall", "s", [fresh], ["a"], now - 10 * 86_400_000);
    await recordHits("recall", "s2", [stale], ["b"], now - 31 * 86_400_000);
    await recordHits("recall", "s3", [dead], ["c"], now - 400 * 86_400_000);
    const ledger = await readLedger();
    const deadSet = neverRetrieved([fresh, stale, dead, never], ledger).map(
      (m) => m.ts,
    );
    expect(deadSet).toEqual([
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
      "2026-01-04T00:00:00.000Z",
    ]);
    expect(usedRecently([fresh, stale, dead, never], ledger)).toBe(1);
  });

  test("use recency breaks a score tie but never crosses a real score gap", async () => {
    await appendMemory({
      type: "learning",
      scope: "reports",
      content: "alpha bravo reporting rule one",
    });
    await appendMemory({
      type: "learning",
      scope: "reports",
      content: "alpha bravo reporting rule two",
    });
    const rows = await loadAll();
    const [a, b] = rows;
    // A true tie, decided by the ledger rather than by file order.
    const use = new Map<string, { count: number; last: string }>([
      [a!.ts, { count: 4, last: "2026-09-01T00:00:00.000Z" }],
    ]);
    const [top] = scoreMemories("alpha bravo reporting", rows, 2, use);
    expect(top!.ts).toBe(a!.ts);
    // With a rare-word advantage on b, reinforcement on a must not flip it.
    await appendMemory({
      type: "learning",
      scope: "reports",
      content: "alpha bravo reporting with molybdenum",
    });
    const wide = await loadAll();
    const winner = scoreMemories(
      "alpha bravo reporting molybdenum",
      wide,
      1,
      use,
    );
    expect(winner[0]!.content).toInclude("molybdenum");
  });
});

describe("the surfaces read the ledger honestly", () => {
  const day = (msAgo: number) =>
    new Date(Date.now() - msAgo * 86_400_000).toISOString();

  test("a young ledger qualifies the dead-weight line instead of inflating never", () => {
    const store = {
      active: 10,
      superseded: 0,
      open: 0,
      scopes: 3,
      malformed: 0,
      neverRetrieved: 7,
      ledgerSince: day(2),
    };
    const report = renderMemoryReport({ status: null, store, blocked: [] });
    expect(report).toInclude(
      "retrieved 3 rows in the last 30d; never retrieved 7 (70%)",
    );
    expect(report).toInclude("ledger only covers since");
    expect(ledgerIsYoung(store.ledgerSince)).toBe(true);
  });

  // the outcome line is the only place a user learns what the join can
  // and cannot claim. It must state the floor and the correlation, in-line.
  test("the outcome line states the correlation and never claims a cause", () => {
    const base = {
      active: 10,
      superseded: 0,
      open: 0,
      scopes: 3,
      malformed: 0,
      neverRetrieved: 7,
      ledgerSince: day(45),
    };
    const withOutcomes = renderMemoryReport({
      status: null,
      store: {
        ...base,
        useOutcome: {
          rowsMeasured: 4,
          joined: 9,
          clean: 6,
          failAfter: 3,
          evictCandidates: 2,
        },
      },
      blocked: [],
    });
    expect(withOutcomes).toInclude(
      "outcome-linked 9 rides over 4 rows: 6 clean row/turns, 3 failed row/turns",
    );
    expect(withOutcomes).toInclude(
      `2 candidates at ≥${EVICT_MIN_RIDES} rides with no clean turn`,
    );
    expect(withOutcomes).toInclude("correlation on the ride's own turn");
    // The line must not read as a verdict on the rows.
    expect(withOutcomes).not.toInclude("harmful");
    // And a caller that did not run the join prints no outcome line at all.
    expect(
      renderMemoryReport({ status: null, store: base, blocked: [] }),
    ).not.toInclude("outcome-linked");
  });

  test("an empty ledger says so, and a covered window drops the qualifier", () => {
    const base = {
      active: 4,
      superseded: 0,
      open: 0,
      scopes: 1,
      malformed: 0,
      neverRetrieved: 4,
    };
    expect(
      renderMemoryReport({
        status: null,
        store: { ...base, ledgerSince: null },
        blocked: [],
      }),
    ).toInclude("ledger only covers since no lines yet");
    const mature = renderMemoryReport({
      status: null,
      store: { ...base, ledgerSince: day(45) },
      blocked: [],
    });
    expect(mature).toInclude(
      "never retrieved 4 (100%) — reported, not acted on",
    );
    expect(mature).not.toInclude("ledger only covers since");
    expect(ledgerIsYoung(day(45))).toBe(false);
  });

  test("the ledger file is reserved and never ingested as memory rows", async () => {
    await recordHits("recall", "s", [row("2026-01-01T00:00:00.000Z")], ["x"]);
    expect(hitsFile()).toBe(join(memoryRoot(), HITS_FILENAME));
    expect(await loadAll()).toHaveLength(0); // loadAll() must skip hits.logfmt
  });
});

//(same gap, pre-existing): the ring's rotation republishes the halved
// ledger under the store lock WITHOUT fileIdentity anchor. On Windows a
// reader's open handle refuses the handover rename, writeAtomic fails its
// single attempt, recordHits swallows it (telemetry never breaks retrieval) -
// and the ledger silently stays over the cap: a lost rotation, no signal.
// Anchored, the retry lands once the handle closes. POSIX renames never fail
// this way, hence the gate; the red leg is windows-latest CI.
describe.skipIf(process.platform !== "win32")(
  "ledger rotation under Windows reader contention",
  () => {
    test("a request-time pull gives up a refused rotation without waiting for reader retries", async () => {
      const original = "ev=padding filler=" + "x".repeat(2_100_000) + "\n";
      writeFileSync(hitsFile(), original);
      const fd = openSync(hitsFile(), "r");
      const started = performance.now();
      try {
        const now = Date.now();
        expect(
          await recordHits(
            "pull",
            "busy-reader",
            [row("2026-11-21T10:00:00Z")],
            [],
            now,
            1,
            "turn",
            { lockWaitMs: 50, observedAt: now },
          ),
        ).toBe(false);
        expect(performance.now() - started).toBeLessThan(800);
        expect(ledgerText()).toBe(original);
      } finally {
        closeSync(fd);
      }
      const now = Date.now() + 10000;
      expect(
        await recordHits(
          "pull",
          "released-reader",
          [row("2026-11-21T10:00:00Z")],
          [],
          now,
          1,
          "turn",
          { lockWaitMs: 50, observedAt: now },
        ),
      ).toBe(true);
    });
    test("a rotation against a reader holding the ledger retries and lands, not silently fails", async () => {
      const filler = Array.from(
        { length: 40_000 },
        (_, i) =>
          `ev=memory_used ts=2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z filler=${i}`,
      );
      writeFileSync(hitsFile(), filler.join("\n") + "\n");
      expect(filler.join("\n").length).toBeGreaterThan(2_000_000); // the rotation must actually trigger
      const fd = openSync(hitsFile(), "r"); // blocks the destination's replacement, not appends
      let released = false;
      const release = () => {
        if (!released) (released = true), closeSync(fd);
      };
      setTimeout(release, 400);
      // Red pre-fix: the refusal is swallowed and recordHits reports false while
      // the ledger stays over the cap. Green anchored: retry, halve, land.
      expect(
        await recordHits(
          "inject",
          "ses-rot",
          [row("2026-01-01T00:00:00.000Z")],
          ["keep"],
        ),
      ).toBe(true);
      release();
      const lines = ledgerText().trim().split("\n");
      expect(lines.length).toBeLessThan(filler.length + 1); // the halving happened
      expect(lines[lines.length - 1]).toInclude("keep"); // and the newest line rides the halved file
    });
  },
);

// --- the row-to-outcome edge ------------------------------------------------
//
// The ledger used to record that a row rode and nothing about what happened
// next, so a row that reliably misled the agent accrued hits and got BOOSTED by
// `useBoost`. These tests pin the minimum that makes usefulness measurable: a
// turn on the ride, a gate verdict for that turn, and a join that refuses to
// claim more than it saw.

describe("rides carry the turn they landed on", () => {
  test("a known turn is written; an unknown one is absent, never zero", async () => {
    expect(
      await recordHits(
        "inject",
        "ses-turn",
        [row("2026-01-01T00:00:00.000Z")],
        ["build"],
        Date.parse("2026-06-01T00:00:00Z"),
        4,
      ),
    ).toBe(true);
    expect(ledgerText()).toInclude("turn=4");

    expect(
      await recordHits(
        "recall",
        "ses-turn-2",
        [row("2026-01-02T00:00:00.000Z")],
        ["build"],
        Date.parse("2026-06-01T00:00:01Z"),
      ),
    ).toBe(true);
    const lines = ledgerText().trim().split("\n");
    expect(lines[lines.length - 1]).not.toInclude("turn=");
  });

  test("readRides keeps the (sid, turn) grouping readLedger aggregates away", async () => {
    await recordHits(
      "inject",
      "ses-join",
      [row("2026-01-01T00:00:00.000Z"), row("2026-01-03T00:00:00.000Z")],
      ["tax"],
      Date.parse("2026-06-01T00:00:00Z"),
      7,
    );
    const rides = await readRides();
    expect(rides.length).toBe(1);
    expect(rides[0]).toMatchObject({ sid: "ses-join", turn: 7 });
    expect(rides[0]!.mems).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
  });
});

describe("turn outcomes", () => {
  test("each gate appends independently and unknown verdicts are ignored", async () => {
    await recordOutcome("sid", 1, "FAIL", "test", 10);
    const first = ledgerText();
    await recordOutcome("sid", 1, "PASS", "test", 20);
    expect(ledgerText().startsWith(first)).toBe(true);
    expect((await readOutcomes()).map((o) => o.outcome)).toEqual([
      "FAIL",
      "PASS",
    ]);
    writeFileSync(hitsFile(), first.replace("outcome=fail", "outcome=unknown"));
    expect(await readOutcomes()).toEqual([]);
  });

  test("legacy summaries retain only verdicts with known timing", async () => {
    const common =
      "ev=turn_outcome ts=2026-01-01T00:00:03.000Z sid=s turn=1 calls=2 ";
    writeFileSync(
      hitsFile(),
      [
        common + "fails=1 outcome=fail",
        common + "fails=2 outcome=fail",
        common + "fails=1 outcome=fail lastFail=2026-01-01T00:00:02.000Z",
        common + "fails=0 outcome=clean",
      ].join("\n"),
    );
    expect((await readOutcomes()).map((o) => [o.outcome, o.lastFail])).toEqual([
      ["FAIL", undefined],
      ["FAIL", "2026-01-01T00:00:02.000Z"],
      ["PASS", undefined],
    ]);
  });

  test("concurrent gates and a hit survive rotation together", async () => {
    const filler = ("x".repeat(1023) + "\n").repeat(2000);
    writeFileSync(hitsFile(), filler);
    const writes = await Promise.all([
      recordHits("inject", "s", [row("r")], [], 1, 1, "k"),
      recordOutcome("s", 1, "FAIL", "test", 2, "k"),
      recordOutcome("s", 1, "PASS", "lint", 3, "k"),
    ]);
    expect(writes).toEqual([true, true, true]);
    expect(ledgerText().length).toBeLessThan(filler.length);
    const outcomes = await readOutcomes();
    expect(outcomes).toHaveLength(2);
    expect(joinUseWithOutcomes(await readRides(), outcomes).get("r")).toEqual({
      rides: 1,
      joined: 1,
      clean: 0,
      failAfter: 1,
    });
  });

  test("an evicted session can reuse turn one without joining its old ride", async () => {
    const sid = "evicted";
    markTurn(sid);
    const old = peekTurn(sid)!;
    await recordHits("inject", sid, [row("old")], [], 1, old.turn, old.key);
    for (let i = 0; i < SESSION_CAP; i++) markTurn("other-" + i);
    expect(peekTurn(sid)).toBeUndefined();
    markTurn(sid);
    const fresh = peekTurn(sid)!;
    expect(fresh.turn).toBe(old.turn);
    expect(fresh.key).not.toBe(old.key);
    await recordOutcome(sid, fresh.turn, "FAIL", "test", 2, fresh.key);
    expect(
      joinUseWithOutcomes(await readRides(), await readOutcomes()).get("old")
        ?.joined,
    ).toBe(0);
  });

  test("failed outcome writes are counted only for the current store", async () => {
    mkdirSync(hitsFile());
    expect(await recordOutcome("sid", 1, "FAIL", "test")).toBe(false);
    expect(getDroppedOutcomeWrites()).toBe(1);
    process.env.OPENCODE_MEMORY_DIR = join(root, "other");
    expect(getDroppedOutcomeWrites()).toBe(0);
  });

  test("only gates after retrieval count, once per row and turn", async () => {
    const at = Date.UTC(2026, 5, 1);
    const early = row("early"),
      late = row("late"),
      after = row("after");
    await recordHits("inject", "s", [early], [], at, 1, "k");
    await recordHits("recall", "s", [early], [], at + 1, 1, "k");
    await recordOutcome("s", 1, "FAIL", "test", at + 2, "k");
    await recordHits("recall", "s", [late], [], at + 3, 1, "k");
    const summarize = async () =>
      joinUseWithOutcomes(await readRides(), await readOutcomes());
    expect((await summarize()).get(late.ts)?.joined).toBe(0);
    await recordOutcome("s", 1, "PASS", "test", at + 4, "k");
    await recordHits("recall", "s", [after], [], at + 5, 1, "k");
    const stats = await summarize();
    expect(stats.get(early.ts)).toEqual({
      rides: 2,
      joined: 2,
      clean: 0,
      failAfter: 1,
    });
    expect(stats.get(late.ts)).toEqual({
      rides: 1,
      joined: 1,
      clean: 1,
      failAfter: 0,
    });
    expect(stats.get(after.ts)?.joined).toBe(0);
  });

  test("one line per distinct turn, readable back as PASS or FAIL", async () => {
    expect(
      await recordOutcome(
        "ses-out",
        2,
        "FAIL",
        "tsc",
        Date.parse("2026-06-01T00:00:00Z"),
      ),
    ).toBe(true);
    expect(
      await recordOutcome(
        "ses-out",
        3,
        "PASS",
        "test",
        Date.parse("2026-06-01T00:01:00Z"),
      ),
    ).toBe(true);
    const got = await readOutcomes();
    expect(got).toEqual([
      {
        ts: "2026-06-01T00:00:00.000Z",
        sid: "ses-out",
        turn: 2,
        outcome: "FAIL",
        cmd: "tsc",
      },
      {
        ts: "2026-06-01T00:01:00.000Z",
        sid: "ses-out",
        turn: 3,
        outcome: "PASS",
        cmd: "test",
      },
    ]);
  });

  test("an outcome line is not a ride, and a ride line is not an outcome", async () => {
    await recordOutcome("ses-mix", 1, "PASS", "tsc");
    await recordHits(
      "inject",
      "ses-mix",
      [row("2026-01-01T00:00:00.000Z")],
      ["tsc"],
      Date.now(),
      1,
    );
    expect((await readOutcomes()).length).toBe(1);
    expect((await readRides()).length).toBe(1);
    // The pre-existing reader must skip the new kind, not count it as a use.
    const ledger = await readLedger();
    expect(ledger.lines).toBe(1);
  });

  test("a session id or a turn that is not a number records nothing", async () => {
    expect(await recordOutcome("", 1, "PASS", "tsc")).toBe(false);
    expect(await recordOutcome("ses-x", Number.NaN, "PASS", "tsc")).toBe(false);
  });
});

describe("joinUseWithOutcomes claims only what it saw", () => {
  const ride = (sid: string, turn: number | undefined, mems: string[]) => ({
    ts: "2026-06-01T00:00:00.000Z",
    src: "inject" as const,
    sid,
    mems,
    terms: [],
    ...(turn === undefined ? {} : { turn }),
  });

  test("a ride on a passing turn is clean, on a failing turn is failAfter", () => {
    const joined = joinUseWithOutcomes(
      [ride("s", 1, ["a"]), ride("s", 2, ["b"])],
      [
        {
          ts: "2026-07-01T00:00:00.000Z",
          sid: "s",
          turn: 1,
          outcome: "PASS",
          cmd: "tsc",
        },
        {
          ts: "2026-07-01T00:00:00.000Z",
          sid: "s",
          turn: 2,
          outcome: "FAIL",
          cmd: "test",
        },
      ],
    );
    expect(joined.get("a")).toEqual({
      rides: 1,
      joined: 1,
      clean: 1,
      failAfter: 0,
    });
    expect(joined.get("b")).toEqual({
      rides: 1,
      joined: 1,
      clean: 0,
      failAfter: 1,
    });
  });

  test("a ride with no turn, or in a session with no gate, is a ride only", () => {
    const joined = joinUseWithOutcomes(
      [ride("s", undefined, ["a"]), ride("s", 9, ["b"])],
      [
        {
          ts: "2026-07-01T00:00:00.000Z",
          sid: "s",
          turn: 1,
          outcome: "PASS",
          cmd: "tsc",
        },
      ],
    );
    expect(joined.get("a")).toEqual({
      rides: 1,
      joined: 0,
      clean: 0,
      failAfter: 0,
    });
    expect(joined.get("b")).toEqual({
      rides: 1,
      joined: 0,
      clean: 0,
      failAfter: 0,
    });
  });

  test("a failing gate wins the turn even when a later gate passed it", () => {
    const joined = joinUseWithOutcomes(
      [ride("s", 4, ["a"])],
      [
        {
          ts: "2026-07-01T00:00:00.000Z",
          sid: "s",
          turn: 4,
          outcome: "PASS",
          cmd: "lint",
        },
        {
          ts: "2026-07-01T00:00:00.000Z",
          sid: "s",
          turn: 4,
          outcome: "FAIL",
          cmd: "test",
        },
      ],
    );
    expect(joined.get("a")).toEqual({
      rides: 1,
      joined: 1,
      clean: 0,
      failAfter: 1,
    });
  });

  test("the same turn number in a different session does not join", () => {
    const joined = joinUseWithOutcomes(
      [ride("s1", 1, ["a"])],
      [
        {
          ts: "2026-07-01T00:00:00.000Z",
          sid: "s2",
          turn: 1,
          outcome: "FAIL",
          cmd: "test",
        },
      ],
    );
    expect(joined.get("a")).toEqual({
      rides: 1,
      joined: 0,
      clean: 0,
      failAfter: 0,
    });
  });
});

describe("summarizeStore reports eviction candidates without acting", () => {
  const active = (ts: string): Memory => ({ ...row(ts), status: "settled" });

  test("five rides with no clean turn is a candidate; one clean turn clears it", () => {
    const rides = [
      ...Array.from({ length: 5 }, (_, i) => ({
        ts: `2026-06-0${i + 1}T00:00:00.000Z`,
        src: "inject" as const,
        sid: `s${i}`,
        mems: ["bad"],
        terms: [],
        turn: 1,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        ts: `2026-06-0${i + 1}T00:00:00.000Z`,
        src: "inject" as const,
        sid: `t${i}`,
        mems: ["mixed"],
        terms: [],
        turn: 1,
      })),
    ];
    const outcomes = [
      ...Array.from({ length: 5 }, (_, i) => ({
        ts: "2026-07-01T00:00:00.000Z",
        sid: `s${i}`,
        turn: 1,
        outcome: "FAIL" as const,
        cmd: "test",
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        ts: "2026-07-01T00:00:00.000Z",
        sid: `t${i}`,
        turn: 1,
        outcome: "FAIL" as const,
        cmd: "test",
      })),
      {
        ts: "2026-07-01T00:00:00.000Z",
        sid: "t4",
        turn: 1,
        outcome: "PASS" as const,
        cmd: "test",
      },
    ];
    const { counts } = summarizeStore(
      [active("bad"), active("mixed"), active("unseen")],
      { byRow: new Map(), since: null, lines: 0 },
      0,
      { rides, outcomes },
    );
    expect(counts.useOutcome).toEqual({
      rowsMeasured: 2,
      joined: 10,
      clean: 1,
      failAfter: 9,
      evictCandidates: 1,
    });
  });

  test("the visible details stay bounded and prioritize eviction candidates", () => {
    const rows = Array.from({ length: 1200 }, (_, i) => active(String(i)));
    const ride = {
      ts: "2026-06-01T00:00:00.000Z",
      sid: "s",
      turn: 1,
      src: "inject" as const,
      terms: [],
    };
    const rides = rows.map((m) => ({ ...ride, mems: [m.ts] }));
    rides.push(...Array(4).fill(rides[1199]));
    const outcomes = [
      {
        ...ride,
        ts: "2026-06-01T00:00:01.000Z",
        outcome: "FAIL" as const,
        cmd: "test",
      },
    ];
    const { counts } = summarizeStore(
      rows,
      { byRow: new Map(), since: null, lines: 0 },
      0,
      { rides, outcomes, visible: () => true },
    );
    expect(counts.useOutcome?.details).toHaveLength(21);
    expect(counts.useOutcome?.details?.[0]).toContain(
      "1199 used=5 clean=0 fail_after=1",
    );
    expect(counts.useOutcome?.details?.at(-1)).toContain(
      "1180 more visible rows",
    );
  });

  test("omitting the join leaves the block absent, not zero", () => {
    const { counts } = summarizeStore(
      [active("a")],
      { byRow: new Map(), since: null, lines: 0 },
      0,
    );
    expect(counts.useOutcome).toBeUndefined();
  });
});
