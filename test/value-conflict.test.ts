// Contract (#390): a correction retires the row it corrects IN THE DATA. R3
// (`results-stale-x5/`, 2150 → 1900) kept both values, the correction winning
// only because the model wrote "this supersedes the earlier 2150 bps figure"
// and retrieval happened to prefer it. R3c narrowed the exposure to the
// same-instant tie (3/10) and to any retrieval surfacing the stale row alone.
// GATE-3 rivalry cannot cover this: it competes only decision/preference rows,
// and corrections of remembered facts are context/learning.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAll } from "../src/store/files/load.ts";
import { relevantKnowledge } from "../src/recall/relevant.ts";
import { runWriteGate } from "../src/gate/gate.ts";
import { symbolValues, valueConflicts } from "../src/gate/value-conflict.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import type { Memory } from "../src/store/model/memory.ts";
import { readEvidenceLog } from "./helpers/logfmt.ts";

const mem = (
  ts: string,
  content: string,
  extra: Partial<Memory> = {},
): Memory =>
  ({
    ts,
    type: "context",
    scope: "config",
    content,
    status: "settled",
    ...extra,
  }) as Memory;

describe("symbolValues", () => {
  test("a number after the symbol is its value; the fallback looks before", () => {
    expect(symbolValues("The VAT_BPS constant is 2150 basis points.")).toEqual(
      new Map([["VAT_BPS", "2150"]]),
    );
    expect(symbolValues("Set to 2150, the VAT_BPS constant stands.")).toEqual(
      new Map([["VAT_BPS", "2150"]]),
    );
  });

  test("prose with no symbol yields nothing", () => {
    expect(symbolValues("the rate is 2150 basis points").size).toBe(0);
  });

  test("the scan does not depend on which row ran last", () => {
    // A module-level `g` regex carries lastIndex between calls — the #393 bug.
    // A retirement rule whose answer depends on call order is worse than none,
    // because it looks deterministic.
    const a = "The VAT_BPS constant is 2150 basis points.";
    const b = "The RATE_MAX constant is 30 attempts.";
    symbolValues(a);
    expect(symbolValues(b).get("RATE_MAX")).toBe("30");
    expect(symbolValues(a).get("VAT_BPS")).toBe("2150");
  });
});

describe("valueConflicts", () => {
  const old = mem(
    "2026-10-01T09:00:00.000Z",
    "This site's fallback VAT rate is 2150 basis points.",
  );
  const fix = mem(
    "2026-10-02T09:00:00.000Z",
    "This site's fallback VAT rate is 1900 basis points.",
  );

  test("the R3 hand-seeded pair conflicts on the shared symbol", () => {
    const hits = valueConflicts(fix, [old]);
    expect(hits.length).toBe(1);
    expect(hits[0]?.ts).toBe(old.ts);
    expect(hits[0]?.from).toBe("2150");
    expect(hits[0]?.to).toBe("1900");
  });

  test("agreeing numbers are one fact restated, not a conflict", () => {
    const same = mem(
      "2026-10-02T09:00:00.000Z",
      "This site's fallback VAT rate is 2150 basis points, confirmed by finance.",
    );
    expect(valueConflicts(same, [old])).toEqual([]);
  });

  test("two different facts in one scope coexist", () => {
    // No shared symbol anchor: "retries" and "timeout" are separate claims.
    const a = mem(
      "2026-10-01T09:00:00.000Z",
      "MAX_RETRIES is 3 for the queue.",
    );
    const b = mem(
      "2026-10-02T09:00:00.000Z",
      "TIMEOUT_MS is 30000 for the queue.",
    );
    expect(valueConflicts(b, [a])).toEqual([]);
  });

  test("a history note does not retire the fact it mentions", () => {
    // The misfire class #393 accepted for a REFUSAL is not accepted for a
    // RETIREMENT: with the numbers stripped these are different sentences,
    // and the shape floor must stop it.
    const fact = mem(
      "2026-10-01T09:00:00.000Z",
      "The VAT_BPS constant for this site is 2150 basis points.",
    );
    const note = mem(
      "2026-10-02T09:00:00.000Z",
      "VAT_BPS was introduced in 2024 by the customs team.",
    );
    expect(valueConflicts(note, [fact])).toEqual([]);
  });

  test("#400 review: two environments are two facts, not a correction", () => {
    // The reviewer's pair, verbatim shape: identical sentence, one symbol,
    // disagreeing numbers, different environment. Guards 1–3 all pass
    // (jaccard 0.71); guard 4 must stop the retirement in both directions.
    const prod = mem(
      "2026-10-01T09:00:00.000Z",
      "The MAX_RETRIES constant is 3 in production.",
    );
    const staging = mem(
      "2026-10-02T09:00:00.000Z",
      "The MAX_RETRIES constant is 5 in staging.",
    );
    expect(valueConflicts(staging, [prod])).toEqual([]);
    expect(valueConflicts(prod, [staging])).toEqual([]);
  });

  test("#400 review: an environment-scoped row does not retire the bare default", () => {
    // "is 3" may be the default; hiding it behind one environment's value is
    // the same defect as the pair above, so one-sided scoping coexists too.
    const bare = mem("2026-10-01T09:00:00.000Z", "The MAX_RETRIES is 3.");
    const scoped = mem(
      "2026-10-02T09:00:00.000Z",
      "The MAX_RETRIES is 5 in staging.",
    );
    expect(valueConflicts(scoped, [bare])).toEqual([]);
    expect(valueConflicts(bare, [scoped])).toEqual([]);
  });

  test("#400 review cost check: the same environment still corrects", () => {
    const old = mem(
      "2026-10-01T09:00:00.000Z",
      "The MAX_RETRIES constant is 3 in production.",
    );
    const fix = mem(
      "2026-10-02T09:00:00.000Z",
      "The MAX_RETRIES constant is 4 in production.",
    );
    expect(valueConflicts(fix, [old]).length).toBe(1);
  });

  test("a sign flip is a disagreement, not one fact restated (#399 class)", () => {
    const pos = mem("2026-10-01T09:00:00.000Z", "The TEMP_OFFSET is 5.");
    const neg = mem("2026-10-02T09:00:00.000Z", "The TEMP_OFFSET is -5.");
    expect(valueConflicts(neg, [pos]).length).toBe(1);
    // And the same signed value restated is still agreement.
    expect(
      valueConflicts(mem("2026-10-03T09:00:00.000Z", "TEMP_OFFSET is -5"), [
        neg,
      ]),
    ).toEqual([]);
  });

  test("#400 review round 2: unknown qualifiers (tenants) coexist too", () => {
    // The counterexample that broke the environment dictionary: both
    // qualifier sets empty, retirement fired anyway. The residual rule needs
    // no dictionary — "tenant", "alpha" and "beta" are words one row says
    // and the other does not.
    const alpha = mem(
      "2026-10-01T09:00:00.000Z",
      "The MAX_RETRIES constant is 3 for tenant Alpha.",
    );
    const beta = mem(
      "2026-10-02T09:00:00.000Z",
      "The MAX_RETRIES constant is 5 for tenant Beta.",
    );
    expect(valueConflicts(beta, [alpha])).toEqual([]);
    expect(valueConflicts(alpha, [beta])).toEqual([]);
  });

  test("editorial narration does not block a real correction", () => {
    // The cost of the residual rule, bounded: words that only narrate the
    // correction still retire.
    const old = mem(
      "2026-10-01T09:00:00.000Z",
      "The MAX_RETRIES constant is 3 in production.",
    );
    const fix = mem(
      "2026-10-02T09:00:00.000Z",
      "Corrected: the MAX_RETRIES constant is now 4 in production.",
    );
    expect(valueConflicts(fix, [old]).length).toBe(1);
  });

  test("a version qualifier is not prose glue", () => {
    const v2 = mem(
      "2026-10-01T09:00:00.000Z",
      "The MAX_RETRIES default is 3 on v2.",
    );
    const v3 = mem(
      "2026-10-02T09:00:00.000Z",
      "The MAX_RETRIES default is 5 on v3.",
    );
    expect(valueConflicts(v3, [v2])).toEqual([]);
  });

  test("#400 review round 3: numeric qualifiers are context, not noise", () => {
    // The residual matcher dropped EVERY pure number, so "tenant 101" and
    // "tenant 202" differed only in digits the comparison never saw — and
    // tenant 101 retired. Only the two compared values may drop out.
    const t101 = mem(
      "2026-10-01T09:00:00.000Z",
      "The MAX_RETRIES constant is 3 for tenant 101.",
    );
    const t202 = mem(
      "2026-10-02T09:00:00.000Z",
      "The MAX_RETRIES constant is 5 for tenant 202.",
    );
    expect(valueConflicts(t202, [t101])).toEqual([]);
    expect(valueConflicts(t101, [t202])).toEqual([]);
  });

  test("a correction quoting the old value still retires", () => {
    // Both compared values are skipped on both sides, so R3's shape of
    // correction — naming the number it replaces — keeps working.
    const old = mem(
      "2026-10-01T09:00:00.000Z",
      "The VAT_BPS constant is 2150 basis points.",
    );
    const fix = mem(
      "2026-10-02T09:00:00.000Z",
      "Corrected: the VAT_BPS constant is 1900 basis points, was 2150.",
    );
    expect(valueConflicts(fix, [old]).length).toBe(1);
  });

  test("#400 review round 4: a qualifier repeating the value survives", () => {
    // The literal skip deleted every token equal to a compared value, so
    // "tenant 3" vanished with the asserted 3 and the tenants coexisted no
    // more. The excision is positional: only the number next to the symbol
    // is the corrected value.
    const t3 = mem(
      "2026-10-01T09:00:00.000Z",
      "The MAX_RETRIES constant is 3 for tenant 3.",
    );
    const t5 = mem(
      "2026-10-02T09:00:00.000Z",
      "The MAX_RETRIES constant is 5 for tenant 5.",
    );
    expect(valueConflicts(t5, [t3])).toEqual([]);
    expect(valueConflicts(t3, [t5])).toEqual([]);
  });

  test("a swapped qualifier pair coexists: qualifiers are not citations", () => {
    // Each row's extra number equals the OTHER row's value, so a literal
    // "cites the old value" reading would retire both ways. The citation is
    // only excused when its preceding word is not a content word: "tenant"
    // qualifies, "was" cites.
    const a = mem(
      "2026-10-01T09:00:00.000Z",
      "The MAX_RETRIES constant is 3 for tenant 5.",
    );
    const b = mem(
      "2026-10-02T09:00:00.000Z",
      "The MAX_RETRIES constant is 5 for tenant 3.",
    );
    expect(valueConflicts(b, [a])).toEqual([]);
    expect(valueConflicts(a, [b])).toEqual([]);
  });

  test("an inferred write never retires a user-guided row", () => {
    // The user is the stronger claim; a captured inference burying stated
    // guidance is the wrong-direction fix R3 must not ship with.
    const guided = mem(
      "2026-10-01T09:00:00.000Z",
      "This site's fallback VAT rate is 2150 basis points.",
      {
        tags: ["user-guided"],
      },
    );
    expect(valueConflicts(fix, [guided])).toEqual([]);
    const guidedFix = { ...fix, tags: ["user-guided"] };
    expect(valueConflicts(guidedFix, [guided]).length).toBe(1);
  });

  test("different types and retired rows are never victims", () => {
    const asLearning = mem(old.ts, old.content, { type: "learning" });
    expect(valueConflicts(fix, [asLearning])).toEqual([]);
    const retired = mem(old.ts, old.content, { superseded_by: "x" });
    expect(valueConflicts(fix, [retired])).toEqual([]);
  });
});

describe("the gate retires a corrected row in the data", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osi-valconf-"));
    process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
    setRepoScope(null);
  });
  afterEach(() => {
    setRepoScope(null);
    delete process.env.OPENCODE_MEMORY_DIR;
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  const write = (content: string, extra: Record<string, unknown> = {}) =>
    runWriteGate(
      { type: "context", scope: "site-config", content, ...extra },
      { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true },
    );

  test("the stale row carries superseded_by pointing at the correction", async () => {
    const first = await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    expect(first.action).toBe("promoted");
    const second = await write(
      "This site's fallback VAT rate is 1900 basis points (VAT_BPS).",
    );
    expect(second.action).toBe("promoted");
    const rows = await loadAll();
    const stale = rows.find((m) => m.ts === first.ts);
    expect(stale?.superseded_by).toBe(second.ts);
    expect(stale?.reason).toBe("numeric_conflict");
  });

  test("AC 1: the retired row cannot be injected without the correction", async () => {
    await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    const fix = await write(
      "This site's fallback VAT rate is 1900 basis points (VAT_BPS).",
    );
    const block = await relevantKnowledge(
      "write the declaration file with the fallback VAT rate",
      3,
    );
    expect(block).toContain("1900");
    expect(block).not.toContain("2150");
    // And the retired row is still there — recoverable, not deleted.
    const rows = await loadAll();
    expect(rows.find((m) => m.ts !== fix.ts)?.content).toContain("2150");
  });

  test("#400 review: the two-write probe leaves both environments injectable", async () => {
    const prod = await write("The MAX_RETRIES constant is 3 in production.");
    expect(prod.action).toBe("promoted");
    const staging = await write("The MAX_RETRIES constant is 5 in staging.");
    expect(staging.action).toBe("promoted");
    const rows = await loadAll();
    expect(rows.find((m) => m.ts === prod.ts)?.superseded_by).toBeUndefined();
    // The reviewer's recall probe: a MAX_RETRIES query must not lose the
    // production fact to the staging write.
    const block = await relevantKnowledge(
      "what is the MAX_RETRIES constant value",
      5,
    );
    expect(block).toContain("production");
    expect(block).toContain("staging");
  });

  test("the failed check is auditable: superseded_by names the values", async () => {
    await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    await write(
      "This site's fallback VAT rate is 1900 basis points (VAT_BPS).",
    );
    const line = readEvidenceLog().find(
      (l) => l.ev === "superseded_by" && l.reason === "numeric_conflict",
    );
    expect(line).toBeDefined();
    expect(String(line?.from)).toBe("2150");
    expect(String(line?.to)).toBe("1900");
    expect(String(line?.symbol)).toBe("VAT");
  });

  test("an open planning row does not retire a settled fact", async () => {
    await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    const open = await write(
      "This site's fallback VAT rate is 1900 basis points (VAT_BPS).",
      { status: "open" },
    );
    expect(open.action).toBe("promoted");
    const rows = await loadAll();
    expect(rows.filter((m) => !m.superseded_by).length).toBe(2);
  });

  test("a blocked correction retires nothing", async () => {
    await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    // Exact duplicate: GATE-3 collapses it, nothing lands, nothing retires.
    const dup = await write(
      "This site's fallback VAT rate is 2150 basis points (VAT_BPS).",
    );
    expect(dup.action).toBe("collapsed");
    const rows = await loadAll();
    expect(rows.every((m) => !m.superseded_by)).toBe(true);
  });
});
