// Near-duplicate suppression inside the recall window. The pass is ON by default at 0.8; the
// escape hatch OPENCODE_MEMORY_DEDUP=0 restores the plain top-limit slice,
// byte-identical to the old behavior. The rest pin the guards: a prohibition is never a copy of
// the permission it denies, rows with nothing to compare are never suppressed,
// a misconfigured threshold cannot turn the pass on, and the NEWEST copy of a
// clash survives (§17's adoption rule).
import { describe, expect, test } from "bun:test";
import {
  classifyPair,
  contentTokens,
  DEFAULT_THRESHOLD,
  dedupeThreshold,
  dedupeWindow,
  dedupeWindowGrouped,
  jaccard,
} from "../../src/recall/dedupe.ts";
import type { Memory } from "../../src/store/model/memory.ts";

function mem(
  scope: string,
  content: string,
  ts = "2026-01-01T00:00:00.000Z",
): Memory {
  return {
    ts,
    type: "learning",
    scope,
    content,
    status: "settled",
    file: "",
    index: 0,
  };
}

const COPY_A = mem(
  "review",
  "pr-watch cursor 2026-11-04T11:15Z all nine admitted PRs quiet #277 #280 #281",
);
const COPY_B = mem(
  "review",
  "pr-watch cursor 2026-11-04T11:35Z all nine admitted PRs quiet #277 #280 #281",
);
const OTHER = mem(
  "review",
  "merge gate requires two approvals and a green bench comment",
);
const DISTANT = mem(
  "build",
  "pr-watch cursor 2026-11-04T11:15Z all nine admitted PRs quiet #277 #280 #281",
);
// The review's negation pair, widened so the shared prose alone clears 0.8:
// the prohibition must survive even when everything but `never` is identical.
const PERMIT = mem(
  "git",
  "when releasing from a shared branch force push main after rebasing the release tag onto the approved commit and announce the new head in the PR",
);
const PROHIBIT = mem(
  "git",
  "when releasing from a shared branch never force push main after rebasing the release tag onto the approved commit and announce the new head in the PR",
);

describe("dedupeThreshold", () => {
  test("unset means the default 0.8; explicit zero means off", () => {
    expect(dedupeThreshold({})).toBe(DEFAULT_THRESHOLD);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "" })).toBe(
      DEFAULT_THRESHOLD,
    );
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "  " })).toBe(
      DEFAULT_THRESHOLD,
    );
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "0" })).toBe(0);
  });
  test("an explicit misconfiguration turns the pass off", () => {
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "nope" })).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "1.5" })).toBe(0);
    // At 1e-9 a single shared fragment suppressed rows.
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "1e-9" })).toBe(0);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "0.3" })).toBe(0);
  });
  test("reads the flag", () => {
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "0.8" })).toBe(0.8);
    expect(dedupeThreshold({ OPENCODE_MEMORY_DEDUP: "0.5" })).toBe(0.5);
  });
});

describe("contentTokens", () => {
  test("type and scope are not tokens", () => {
    const t = contentTokens(mem("review", "merge gate approvals"));
    expect(t.has("review")).toBe(false);
    expect(t.has("learning")).toBe(false);
    expect(t.has("merge")).toBe(true);
  });
});

describe("dedupeWindow", () => {
  test("threshold 0 is the plain slice, in order", () => {
    const ranked = [OTHER, COPY_A, DISTANT, COPY_B];
    expect(dedupeWindow(ranked, 3, 0)).toEqual(ranked.slice(0, 3));
  });

  test("skips a near-copy and refills the window", () => {
    const ranked = [COPY_A, COPY_B, OTHER, DISTANT];
    const out = dedupeWindow(ranked, 3, 0.8);
    expect(out).toEqual([COPY_A, OTHER, DISTANT]);
    expect(out.length).toBe(3);
  });

  test("the newest copy of a clash survives, not the highest-ranked", () => {
    const older = mem("review", COPY_A.content, "2026-11-04T11:15:00.000Z");
    const newer = mem("review", COPY_B.content, "2026-11-04T11:35:00.000Z");
    // The stale row ranks first; the pass must return the fresh one.
    expect(dedupeWindow([older, newer], 2, 0.8)).toEqual([newer]);
  });

  test("a prohibition is not a copy of the permission it denies", () => {
    // Token sets differ only by `never`; without the polarity guard the pair
    // reaches Jaccard >= 0.8 and the prohibition is the one deleted.
    const out = dedupeWindow([PERMIT, PROHIBIT], 2, 0.8);
    expect(out).toEqual([PERMIT, PROHIBIT]);
  });

  test("rows differing only by a short numeric fact are not copies", () => {
    // Reproduced: words() drops chunks of length <= 2, so "db 3" and "db 4"
    // leave identical token sets and the older row was suppressed through the
    // handler. Widened past the MIN_CONTENT floor so the short-chunk guard,
    // not the floor, is what keeps both rows.
    const db3 = mem(
      "redis",
      "the rate limiter reads its counters from redis db 3 with a five second eviction window",
    );
    const db4 = mem(
      "redis",
      "the rate limiter reads its counters from redis db 4 with a five second eviction window",
    );
    expect(jaccard(contentTokens(db3), contentTokens(db4))).toBe(1);
    expect(dedupeWindow([db3, db4], 2, 0.8)).toEqual([db3, db4]);
  });

  test("rows with no comparable content are never suppressed", () => {
    // Non-Latin prose tokenises to nothing under words(); the pre-floor version
    // scored two unrelated Chinese rows in one scope at 1.0 and deleted one.
    const cjk1 = mem("auth", "登录令牌在刷新后必须轮换并且旧令牌立即失效");
    const cjk2 = mem("auth", "数据库连接池的最大连接数应该根据并发量调整");
    expect(dedupeWindow([cjk1, cjk2], 2, 0.8)).toEqual([cjk1, cjk2]);
  });

  test("parallel wording in a different scope is not a duplicate", () => {
    const ranked = [COPY_A, DISTANT, OTHER];
    expect(dedupeWindow(ranked, 2, 0.8)).toEqual([COPY_A, DISTANT]);
  });

  test("the threshold boundary is pinned at a measured pair", () => {
    // 13 shared tokens, 4 unique between them: Jaccard 13/17 = 0.765.
    const base =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike";
    const a = mem("review", `${base} november oscar`);
    const b = mem("review", `${base} papa quebec`);
    expect(jaccard(contentTokens(a), contentTokens(b))).toBeCloseTo(
      13 / 17,
      10,
    );
    expect(dedupeWindow([a, b], 2, 0.8)).toEqual([a, b]); // kept at 0.8
    expect(dedupeWindow([a, b], 2, 0.7)).toEqual([a]); // suppressed at 0.7
  });

  test("drops nothing below the threshold", () => {
    const ranked = [OTHER, DISTANT, COPY_A];
    expect(dedupeWindow(ranked, 3, 0.95)).toEqual(ranked);
  });

  test("returns fewer rows rather than repeating one", () => {
    expect(dedupeWindow([COPY_A, COPY_B], 5, 0.8)).toEqual([COPY_A]);
  });

  test("jaccard is symmetric and 1 for identical text", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["a", "b"]);
    expect(jaccard(a, b)).toBe(1);
    expect(jaccard(a, new Set(["b", "c"]))).toBeCloseTo(1 / 3, 10);
  });
});

// A clash is two different situations that share a score: one row corrected the
// other, or the two rows name two things that both hold. Only the first is a
// copy. `classifyPair` reads the leftover token sets to tell them apart, and a
// leftover on BOTH sides is the correction while a leftover on ONE side is the
// second thing.
describe("classifyPair", () => {
  test("no leftovers either way is a copy", () => {
    expect(classifyPair(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(
      "identical",
    );
  });

  test("one side contained in the other names a second thing", () => {
    expect(classifyPair(new Set(["a"]), new Set(["a", "b"]))).toBe("addition");
    expect(classifyPair(new Set(["a", "b"]), new Set(["a"]))).toBe("addition");
  });

  test("a swap leaves a leftover on each side", () => {
    expect(classifyPair(new Set(["a", "b"]), new Set(["a", "c"]))).toBe(
      "substitution",
    );
  });

  test("two empty sets are identical, not an addition", () => {
    // Both containment tests pass vacuously; the copy branch must be first.
    expect(classifyPair(new Set(), new Set())).toBe("identical");
  });

  test("the digit trap: token sets can be equal while the facts differ", () => {
    // words() drops chunks of length <= 2, so "late 0" and "late 1" tokenise
    // alike and classify as a copy. The short-chunk guard, not this function,
    // is what keeps them apart; a change here must not remove that guard.
    const zero = mem("racer", "late 0");
    const one = mem("racer", "late 1");
    expect(classifyPair(contentTokens(zero), contentTokens(one))).toBe(
      "identical",
    );
    expect(dedupeWindow([zero, one], 2, 0.8)).toEqual([zero, one]);
  });
});

// The pair that motivated this: two commands in one scope, 82% shared
// vocabulary because one sentence has one identifier swapped. The shorter
// command is not restated by the longer one — `build:example-images` tokenises
// to CONTAIN `build`, which is what made the pair look like a copy.
const BUILD = mem(
  "BabylonDocs",
  'BabylonDocs build command: run "npm run build" from the repo root (package.json).',
  "2026-10-18T22:04:01.959Z",
);
const BUILD_EXAMPLES = mem(
  "BabylonDocs",
  'BabylonDocs build:example-images command: run "npm run build:example-images" from the repo root (package.json).',
  "2026-10-18T22:04:01.989Z",
);
// The opposite case, and the reason the pass exists: one fact that changed.
// Shared symptom, changed value, so the newer row must take the slot.
const RUNBOOK_FRIDAY = mem(
  "release",
  "the deploy runbook rotates the signing key every friday after the backup window",
  "2026-01-01T00:00:00.000Z",
);
const RUNBOOK_MONDAY = mem(
  "release",
  "the deploy runbook rotates the signing key every monday after the backup window",
  "2026-01-01T00:00:01.000Z",
);

describe("dedupeWindowGrouped", () => {
  test("the two build commands are both kept and reported as a group", () => {
    // Pinned so a tokenizer change cannot turn this into a vacuous pass: the
    // pair must still reach the clash branch.
    expect(
      jaccard(contentTokens(BUILD), contentTokens(BUILD_EXAMPLES)),
    ).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
    const out = dedupeWindowGrouped([BUILD, BUILD_EXAMPLES], 5, 0.8);
    expect(out.rows).toEqual([BUILD, BUILD_EXAMPLES]);
    expect(out.groups).toEqual([[BUILD, BUILD_EXAMPLES]]);
  });

  test("a corrected fact still collapses, and the newer row wins", () => {
    // The regression that matters: grouping must not re-admit a stale row.
    const out = dedupeWindowGrouped([RUNBOOK_FRIDAY, RUNBOOK_MONDAY], 5, 0.8);
    expect(out.rows).toEqual([RUNBOOK_MONDAY]);
    expect(out.groups).toEqual([]);
    expect(out.rows.some((m) => m.content.includes("friday"))).toBe(false);
  });

  test("an exact copy still collapses", () => {
    const out = dedupeWindowGrouped([COPY_A, COPY_B], 5, 0.8);
    expect(out.rows).toEqual([COPY_A]);
    expect(out.groups).toEqual([]);
  });

  // One statement of the checklist, three ways: the longer row adds a stage,
  // the substituted row swaps one step for another, and the last two rows are
  // the longer row typed twice.
  const CHECKLIST =
    "release checklist covers packaging signing testing auditing deployment monitoring alerts backups metrics tracing documentation";
  const WITH_STAGING = `${CHECKLIST} staging`;
  const WITH_ROLLBACKS = CHECKLIST.replace("documentation", "rollbacks");
  const printer = (ts: string) =>
    mem("release", "release printer driver requires manual installation", ts);
  const calendar = (ts: string) =>
    mem("release", "release calendar meeting uses the shared agenda", ts);
  const clashFixture = () => [
    mem("release", CHECKLIST, "2026-01-01T00:00:00.000Z"),
    mem("release", WITH_STAGING, "2026-01-01T00:00:01.000Z"),
    mem("release", WITH_ROLLBACKS, "2026-01-01T00:00:02.000Z"),
    mem("release", WITH_STAGING, "2026-01-01T00:00:03.000Z"),
    printer("2026-01-01T00:00:04.000Z"),
    calendar("2026-01-01T00:00:05.000Z"),
  ];

  test("a row that wins two clashes at once leaves one copy, not two", () => {
    const rows = clashFixture();
    // Pinned so a tokenizer change cannot make this vacuous: the newest row is
    // a substitution of the row it meets first AND an exact copy of the row
    // behind it. Stopping at the first clash moved it into the first slot and
    // left the copy beside it — the same text twice, and a distinct row
    // outside the window never arrived.
    expect(
      jaccard(contentTokens(rows[2]!), contentTokens(rows[3]!)),
    ).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
    expect(classifyPair(contentTokens(rows[2]!), contentTokens(rows[3]!))).toBe(
      "substitution",
    );
    expect(classifyPair(contentTokens(rows[1]!), contentTokens(rows[3]!))).toBe(
      "identical",
    );
    const out = dedupeWindowGrouped(rows, 3, DEFAULT_THRESHOLD);
    expect(out.rows.map((m) => m.ts)).toEqual([
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:04.000Z",
      "2026-01-01T00:00:05.000Z",
    ]);
    expect(out.rows.filter((m) => m.content === WITH_STAGING).length).toBe(1);
  });

  test("the same fixture returns the same window with grouping off", () => {
    // The rollback path must not disagree: it stops at the first clash, so it
    // never reached the duplicate in the first place.
    const out = dedupeWindowGrouped(
      clashFixture(),
      3,
      DEFAULT_THRESHOLD,
      false,
    );
    expect(out.rows.map((m) => m.ts)).toEqual([
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:04.000Z",
      "2026-01-01T00:00:05.000Z",
    ]);
    expect(out.groups).toEqual([]);
  });

  // The two mixed-rank orderings of the same fixture: the substituted row now
  // arrives after an unrelated row, so it meets the additive pair from the far
  // side. Both branches of the ride decision have to hold here, not just the
  // one the original fixture reaches.
  const mixedOrder = (a: number, b: number, d: number) => [
    mem("release", CHECKLIST, `2026-01-01T00:00:0${a}.000Z`),
    printer("2026-01-01T00:00:01.000Z"),
    mem("release", WITH_STAGING, `2026-01-01T00:00:0${b}.000Z`),
    mem("release", WITH_ROLLBACKS, `2026-01-01T00:00:0${d}.000Z`),
    calendar("2026-01-01T00:00:05.000Z"),
  ];
  const PRINTER = "release printer driver requires manual installation";
  const CALENDAR = "release calendar meeting uses the shared agenda";

  test("a candidate that wins one clash and loses another does not ride", () => {
    // The substituted row beats the older additive row but loses to the newer
    // one. Writing the slot it won would drop a row it never outranked.
    const out = dedupeWindowGrouped(mixedOrder(4, 2, 3), 4, DEFAULT_THRESHOLD);
    expect(out.rows.map((m) => m.content)).toEqual([
      CHECKLIST,
      PRINTER,
      WITH_STAGING,
      CALENDAR,
    ]);
  });

  test("a candidate that wins both clashes takes the first slot, not the last", () => {
    // Slot choice is rank, not scan order: taking the last clashing slot moved
    // an unrelated row ahead of the winner and changed the top recall result.
    const out = dedupeWindowGrouped(mixedOrder(0, 2, 3), 4, DEFAULT_THRESHOLD);
    expect(out.rows.map((m) => m.content)).toEqual([
      WITH_ROLLBACKS,
      PRINTER,
      CALENDAR,
    ]);
  });

  test("grouping spends slots and never exceeds the limit", () => {
    const base =
      "the ingest worker retries a failed batch three times then parks it on the dead letter queue";
    const rows = [
      mem("queue", base, "2026-01-01T00:00:05.000Z"),
      mem("queue", `${base} with backoff`, "2026-01-01T00:00:04.000Z"),
      mem("queue", `${base} with jitter`, "2026-01-01T00:00:03.000Z"),
      mem("queue", `${base} with a deadline`, "2026-01-01T00:00:02.000Z"),
      mem("queue", `${base} with tracing`, "2026-01-01T00:00:01.000Z"),
    ];
    const out = dedupeWindowGrouped(rows, 3, 0.8);
    expect(out.rows.length).toBeLessThanOrEqual(3);
  });

  test("a group reports the rows themselves, not their window positions", () => {
    // A later clash overwrites a slot with a newer row. A group keyed on the
    // slot would silently re-point at whatever landed there afterwards.
    const out = dedupeWindowGrouped(
      [BUILD, BUILD_EXAMPLES, RUNBOOK_FRIDAY, RUNBOOK_MONDAY],
      5,
      0.8,
    );
    expect(out.groups).toEqual([[BUILD, BUILD_EXAMPLES]]);
    for (const [a, b] of out.groups) {
      expect(out.rows).toContain(a);
      expect(out.rows).toContain(b);
    }
  });

  test("ordering follows the ranking, never the grouping", () => {
    const out = dedupeWindowGrouped([BUILD, OTHER, BUILD_EXAMPLES], 5, 0.8);
    expect(out.rows).toEqual([BUILD, OTHER, BUILD_EXAMPLES]);
  });

  test("threshold 0 is the plain slice with no groups", () => {
    const ranked = [OTHER, COPY_A, DISTANT, COPY_B];
    const out = dedupeWindowGrouped(ranked, 3, 0);
    expect(out.rows).toEqual(ranked.slice(0, 3));
    expect(out.groups).toEqual([]);
  });

  test("dedupeWindow is the grouped rows, unchanged in shape", () => {
    expect(dedupeWindow([BUILD, BUILD_EXAMPLES], 5, 0.8)).toEqual(
      dedupeWindowGrouped([BUILD, BUILD_EXAMPLES], 5, 0.8).rows,
    );
  });

  test("grouping off restores the single-row window", () => {
    const out = dedupeWindowGrouped([BUILD, BUILD_EXAMPLES], 5, 0.8, false);
    expect(out.rows).toEqual([BUILD_EXAMPLES]);
    expect(out.groups).toEqual([]);
  });

  test("an exact copy never outranks a distinct row for the last slot", () => {
    // The example-images row is kept as an addition against the plain command,
    // and its byte-identical copy then arrives. Grouping on the FIRST clash
    // would keep both copies and drop the prerequisite — the loss this pass
    // exists to prevent, reintroduced by the grouping rule itself.
    const copy = mem(
      "BabylonDocs",
      BUILD_EXAMPLES.content,
      "2026-10-18T22:04:02.000Z",
    );
    const prereq = mem(
      "BabylonDocs",
      "BabylonDocs requires npm >= 11.10.0 per the engines field, the default node fails npm ci, use homebrew node",
      "2026-10-18T22:04:03.000Z",
    );
    const out = dedupeWindowGrouped(
      [BUILD, BUILD_EXAMPLES, copy, prereq],
      3,
      0.8,
    );
    expect(out.rows).toEqual([BUILD, copy, prereq]);
    // The group names the rows that actually ride, not the pair the pass first
    // saw: the copy took the earlier row's slot.
    expect(out.groups).toEqual([[BUILD, copy]]);
    expect(new Set(out.rows.map((m) => m.content)).size).toBe(3);
  });

  test("the cost of the rule, pinned: a longer correction keeps both rows", () => {
    // A row extended in place reads as an addition, so the stale row survives
    // and spends a slot. Accepted: the alternative is deleting a fact that is
    // the only carrier of something true. This test records the cost.
    const before = mem(
      "release",
      "the deploy runbook rotates the signing key every friday after the backup window completes and before the nightly smoke suite starts",
      "2026-01-01T00:00:00.000Z",
    );
    const after = mem(
      "release",
      "the deploy runbook rotates the signing key every friday after the backup window completes and before the nightly smoke suite starts with redundant tracing",
      "2026-01-01T00:00:01.000Z",
    );
    expect(
      jaccard(contentTokens(before), contentTokens(after)),
    ).toBeGreaterThanOrEqual(0.8);
    const out = dedupeWindowGrouped([before, after], 5, 0.8);
    expect(out.groups).toEqual([[before, after]]);
    expect(out.rows).toEqual([before, after]);
  });

  test("grouping off preserves the first-match rule exactly", () => {
    // A rollback flag that changes WHICH facts survive is not a rollback. Here
    // A clashes additively with C and substitutes against B: the pre-grouping
    // pass stopped at its first clash (A) and let C take A's slot, so the
    // answer is C then B. Walking the whole window and preferring a collapse
    // would instead keep A and drop B.
    const a = mem(
      "fixture",
      "alpha bravo charlie delta echo foxtrot golf hotel",
      "2026-01-01T00:00:01.000Z",
    );
    const b = mem(
      "fixture",
      "india bravo charlie delta echo foxtrot golf hotel juliet kilo",
      "2026-01-01T00:00:02.000Z",
    );
    const c = mem(
      "fixture",
      "alpha bravo charlie delta echo foxtrot golf hotel juliet kilo",
      "2026-01-01T00:00:03.000Z",
    );
    const off = dedupeWindowGrouped([a, b, c], 5, 0.8, false);
    expect(off.rows).toEqual([c, b]);
    expect(off.groups).toEqual([]);
    // Grouping on is allowed to differ — that is the feature.
    expect(dedupeWindowGrouped([a, b, c], 5, 0.8, true).rows).toEqual([a, c]);
  });

  test("a window of mutually additive rows yields ONE family", () => {
    // Twenty rows sharing eighty tokens, each adding one more: every pair is
    // additive, so a pair-per-group renderer emits C(5,2) = 10 markers for five
    // facts, all repeating the same Action. One family is one explanation.
    const common = Array.from({ length: 20 }, (_, i) => `tok${i}`).join(" ");
    // Nested, so every pair is a strict containment: row i adds one token to
    // row i-1 rather than swapping one, which would classify as substitution.
    const rows = Array.from({ length: 20 }, (_, i) =>
      mem(
        "fixture",
        `${common} ${Array.from({ length: i + 1 }, (_, j) => `extra${j}`).join(" ")}`,
        `2026-01-01T00:00:${i}.000Z`,
      ),
    );
    const out = dedupeWindowGrouped(rows, 5, 0.8, true);
    expect(out.rows.length).toBe(5);
    expect(out.groups.length).toBe(1);
    expect(out.groups[0]!.length).toBe(5);
    // Every pair inside is additive: the pair renderer emitted 10 lines here.
    expect(
      out.rows
        .map((m) => m.content)
        .join(" ")
        .split("extra").length - 1,
    ).toBeGreaterThan(5);
  });
});
