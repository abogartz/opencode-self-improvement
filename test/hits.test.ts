// The use ledger (#42) at unit altitude. e2e/ledger.test.ts proves the wiring
// through a real host; this file pins the module's own promises — the line
// shape, the throttle and its keys, the ring's rotation, what may and may not
// be written into `terms`, what the ledger can honestly claim about rows it
// has never seen, and the qualifier the surfaces must carry when the ledger
// is too young to call anything "never retrieved".
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import {
  HITS_FILENAME,
  THROTTLE_MS,
  hitsFile,
  neverRetrieved,
  readLedger,
  recordHits,
  resetHitThrottle,
  resetLedgerCache,
  useSignals,
  usedRecently,
} from "../src/hits/ledger.ts";
import { appendMemory } from "../src/store/files/append.ts"
import { loadAll } from "../src/store/files/load.ts";
import { scoreMemories, words } from "../src/recall/score.ts"
import { sharedTerms } from "../src/recall/shared-terms.ts";
import { ledgerIsYoung } from "../src/status/metrics.ts"
import { renderMemoryReport } from "../src/status/report.ts";
import type { Memory } from "../src/store/model/memory.ts";

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
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const ledgerText = () => readFileSync(hitsFile(), "utf8");
const row = (ts: string): Memory =>
  ({ ts, type: "learning", scope: "s", content: `fact at ${ts}`, file: "x.logfmt", index: 0 }) as Memory;

describe("the ledger line", () => {
  test("one exact line per source, with the rows credited and the terms they shared", async () => {
    const hit = await recordHits("pull", "ses-1", [row("2026-01-01T00:00:00.000Z")], ["build"], Date.parse("2026-06-01T00:00:00Z"));
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

  test("an empty row-set is not a use, and terms are capped", async () => {
    expect(await recordHits("inject", "s", [], ["x"])).toBe(false);
    const many = Array.from({ length: 12 }, (_, i) => `term${i}`);
    await recordHits("recall", "s", [row("2026-01-01T00:00:00.000Z")], many);
    const ledger = await readLedger();
    expect(ledger.byRow.get("2026-01-01T00:00:00.000Z")?.terms).toHaveLength(8);
  });

  test("terms can only ever be words the row itself contains", () => {
    // The privacy guarantee of #42: the ledger stores no prompt text. What it
    // stores is the INTERSECTION of query words and the row's own vocabulary,
    // so every logged term already exists inside the row it points at.
    const m: Memory = {
      ts: "2026-01-01T00:00:00.000Z",
      type: "learning",
      scope: "deploys",
      content: "staging deploys run make deploy-staging after the vpn is up",
    } as Memory;
    const query = "how do we promote to staging after the vpn, plus zzzqqq private prompt phrase";
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
  test("a repeat within the window adds nothing; after it, the use counts again", async () => {
    const t0 = Date.parse("2026-06-01T00:00:00Z");
    const rows = [row("2026-01-01T00:00:00.000Z")];
    expect(await recordHits("inject", "ses", rows, ["a"], t0)).toBe(true);
    expect(await recordHits("inject", "ses", rows, ["a"], t0 + THROTTLE_MS - 1)).toBe(false);
    expect(await recordHits("inject", "ses", rows, ["a"], t0 + THROTTLE_MS)).toBe(true);
    expect(await readLedger()).toEqual(await readLedger()); // still parseable
    expect((await readLedger()).lines).toBe(2);
  });

  test("the throttle key is (source, session, row-set) — each axis varies freely", async () => {
    const t0 = Date.parse("2026-06-01T00:00:00Z");
    const rows = [row("2026-01-01T00:00:00.000Z")];
    expect(await recordHits("inject", "ses", rows, [], t0)).toBe(true);
    expect(await recordHits("recall", "ses", rows, [], t0)).toBe(true); // other source
    expect(await recordHits("inject", "other", rows, [], t0)).toBe(true); // other session
    expect(await recordHits("inject", "ses", [row("2026-01-02T00:00:00.000Z")], [], t0)).toBe(true); // other rows
    expect((await readLedger()).lines).toBe(4);
  });
});

describe("the ring", () => {
  test("over the size cap the older half is dropped whole-line and the newest survives", async () => {
    // ~2.4 MB of filler first lines, oldest on top; then one real hit.
    const filler = Array.from(
      { length: 40_000 },
      (_, i) => `ev=memory_used ts=2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z filler=${i}`,
    );
    writeFileSync(hitsFile(), filler.join("\n") + "\n");
    expect(filler.join("\n").length).toBeGreaterThan(2_000_000);
    await recordHits("inject", "ses", [row("2026-01-01T00:00:00.000Z")], ["keep"]);
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
    await appendMemory({ type: "learning", scope: "rev", content: "the vault rotates on the first monday" });
    const [original] = await loadAll();
    await recordHits("recall", "s", [original!], ["vault"]);
    const ledger = await readLedger();
    expect(ledger.byRow.get(original!.ts)?.count).toBe(1);

    // "Prune" (delete the day file) and re-capture the same fact.
    rmSync(memoryRoot(), { recursive: true, force: true });
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
    await appendMemory({ type: "learning", scope: "rev", content: "the vault rotates on the first monday" });
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
    const deadSet = neverRetrieved([fresh, stale, dead, never], ledger).map((m) => m.ts);
    expect(deadSet).toEqual(["2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z", "2026-01-04T00:00:00.000Z"]);
    expect(usedRecently([fresh, stale, dead, never], ledger)).toBe(1);
  });

  test("use recency breaks a score tie but never crosses a real score gap", async () => {
    await appendMemory({ type: "learning", scope: "reports", content: "alpha bravo reporting rule one" });
    await appendMemory({ type: "learning", scope: "reports", content: "alpha bravo reporting rule two" });
    const rows = await loadAll();
    const [a, b] = rows;
    // A true tie, decided by the ledger rather than by file order.
    const use = new Map<string, { count: number; last: string }>([
      [a!.ts, { count: 4, last: "2026-09-01T00:00:00.000Z" }],
    ]);
    const [top] = scoreMemories("alpha bravo reporting", rows, 2, use);
    expect(top!.ts).toBe(a!.ts);
    // With a rare-word advantage on b, reinforcement on a must not flip it.
    await appendMemory({ type: "learning", scope: "reports", content: "alpha bravo reporting with molybdenum" });
    const wide = await loadAll();
    const winner = scoreMemories("alpha bravo reporting molybdenum", wide, 1, use);
    expect(winner[0]!.content).toInclude("molybdenum");
  });
});

describe("the surfaces read the ledger honestly", () => {
  const day = (msAgo: number) => new Date(Date.now() - msAgo * 86_400_000).toISOString();

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
    expect(report).toInclude("retrieved 3 rows in the last 30d; never retrieved 7 (70%)");
    expect(report).toInclude("ledger only covers since");
    expect(ledgerIsYoung(store.ledgerSince)).toBe(true);
  });

  test("an empty ledger says so, and a covered window drops the qualifier", () => {
    const base = { active: 4, superseded: 0, open: 0, scopes: 1, malformed: 0, neverRetrieved: 4 };
    expect(renderMemoryReport({ status: null, store: { ...base, ledgerSince: null }, blocked: [] })).toInclude(
      "ledger only covers since no lines yet",
    );
    const mature = renderMemoryReport({ status: null, store: { ...base, ledgerSince: day(45) }, blocked: [] });
    expect(mature).toInclude("never retrieved 4 (100%) — reported, not acted on");
    expect(mature).not.toInclude("ledger only covers since");
    expect(ledgerIsYoung(day(45))).toBe(false);
  });

  test("the ledger file is reserved and never ingested as memory rows", async () => {
    await recordHits("recall", "s", [row("2026-01-01T00:00:00.000Z")], ["x"]);
    expect(hitsFile()).toBe(join(memoryRoot(), HITS_FILENAME));
    expect(await loadAll()).toHaveLength(0); // loadAll() must skip hits.logfmt
  });
});

// #106 (same gap, pre-existing): the ring's rotation republishes the halved
// ledger under the store lock WITHOUT #89's fileIdentity anchor. On Windows a
// reader's open handle refuses the handover rename, writeAtomic fails its
// single attempt, recordHits swallows it (telemetry never breaks retrieval) -
// and the ledger silently stays over the cap: a lost rotation, no signal.
// Anchored, the retry lands once the handle closes. POSIX renames never fail
// this way, hence the gate; the red leg is windows-latest CI.
describe.skipIf(process.platform !== "win32")("ledger rotation under Windows reader contention (#106)", () => {
  test("a rotation against a reader holding the ledger retries and lands, not silently fails", async () => {
    const filler = Array.from(
      { length: 40_000 },
      (_, i) => `ev=memory_used ts=2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z filler=${i}`,
    );
    writeFileSync(hitsFile(), filler.join("\n") + "\n");
    expect(filler.join("\n").length).toBeGreaterThan(2_000_000); // the rotation must actually trigger
    const fd = openSync(hitsFile(), "r"); // blocks the destination's replacement, not appends
    let released = false;
    const release = () => {
      if (!released) released = true, closeSync(fd);
    };
    setTimeout(release, 400);
    // Red pre-fix: the refusal is swallowed and recordHits reports false while
    // the ledger stays over the cap. Green anchored: retry, halve, land.
    expect(await recordHits("inject", "ses-rot", [row("2026-01-01T00:00:00.000Z")], ["keep"])).toBe(true);
    release();
    const lines = ledgerText().trim().split("\n");
    expect(lines.length).toBeLessThan(filler.length + 1); // the halving happened
    expect(lines[lines.length - 1]).toInclude("keep"); // and the newest line rides the halved file
  });
});
