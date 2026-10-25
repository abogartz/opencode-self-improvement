// #45 — consolidation proposals. The rule under test is the one the ticket set:
// a merge is proposed only when replaying the cluster's OWN logged reads proves
// the merged row catches at least as many reads as the best single member did.
// Resemblance alone never earns a proposal.
import { describe, expect, test } from "bun:test";
import type { Memory } from "../src/memory.ts";
import type { UseSignal } from "../src/hits.ts";
import {
  DEFAULT_JACCARD,
  MAX_MERGED_KW,
  clustersFor,
  proposeCluster,
  proposeConsolidations,
  readsFor,
  renderProposals,
  survivorFor,
} from "../src/consolidate.ts";

let n = 0;
const mem = (over: Partial<Memory> & { content: string }): Memory => {
  n++;
  return {
    ts: `2026-0${(n % 9) + 1}-1${n % 9}T10:0${n % 10}:00.000Z`,
    type: "learning",
    scope: "build",
    file: "x.logfmt",
    index: n,
    status: "settled",
    ...over,
  };
};

const A = "the arm64 build box compiles the flimflam pipeline with bun build and no extra flags";
const B = "the arm64 build box compiles the flimflam pipeline with bun build without extra flags at all";
const C = "finance reconciles the zebra brasserie ledger nightly and mails a digest before opening";

describe("consolidation clustering (#45)", () => {
  test("near-duplicate settled rows in one scope and type form one cluster", () => {
    const rows = [mem({ content: A }), mem({ content: B }), mem({ content: C })];
    const groups = clustersFor(rows);
    expect(groups.length).toBe(1);
    expect(groups[0]!.length).toBe(2);
  });

  test("clusters never cross scope or type", () => {
    const rows = [mem({ content: A, scope: "build" }), mem({ content: B, scope: "deploy" })];
    expect(clustersFor(rows)).toEqual([]);
    const typed = [mem({ content: A, type: "learning" }), mem({ content: B, type: "pattern" })];
    expect(clustersFor(typed)).toEqual([]);
  });

  test("an open thread is never consolidation material", () => {
    // An open row is a live plan the panel is showing; collapsing it destroys
    // the frontier, even when it reads like a duplicate.
    const rows = [mem({ content: A, status: "open" }), mem({ content: B })];
    expect(clustersFor(rows)).toEqual([]);
  });

  test("superseded rows are out of the pool", () => {
    const a = mem({ content: A });
    const b = mem({ content: B, superseded_by: a.ts });
    expect(clustersFor([a, b])).toEqual([]);
  });

  test("the jaccard floor is configurable and defaults to the documented value", () => {
    expect(DEFAULT_JACCARD).toBe(0.55);
    const loose = mem({ content: "bun test runs the suite from the repo root before pushing" });
    const other = mem({ content: "bun test is the suite runner used in ci before deploys" });
    expect(clustersFor([loose, other]).length).toBe(0);
    expect(clustersFor([loose, other], { jaccard: 0.25 }).length).toBe(1);
  });
});

describe("canonical row selection", () => {
  test("the most recently used member wins, not the newest row", () => {
    const older = mem({ content: A, ts: "2026-01-01T00:00:00.000Z" });
    const newer = mem({ content: B, ts: "2026-06-01T00:00:00.000Z" });
    const use = new Map<string, UseSignal>([
      [older.ts, { count: 3, last: "2026-09-01T00:00:00.000Z", terms: ["bun"] }],
      [newer.ts, { count: 1, last: "2026-02-01T00:00:00.000Z", terms: [] }],
    ]);
    expect(survivorFor([older, newer], use).ts).toBe(older.ts);
  });

  test("with no ledger knowledge the newest row is canonical", () => {
    const older = mem({ content: A, ts: "2026-01-01T00:00:00.000Z" });
    const newer = mem({ content: B, ts: "2026-06-01T00:00:00.000Z" });
    expect(survivorFor([older, newer], new Map())).toBe(newer);
  });

  test("the merge is deterministic prose plus inherited aliases, never a rewrite", () => {
    // The newer row is canonical with an empty ledger, so the canonical content
    // must be that row's sentence byte-for-byte — no model rewrote anything.
    const older = mem({ content: A, ts: "2026-01-01T00:00:00.000Z", kw: ["compile"] });
    const newer = mem({ content: B, ts: "2026-06-01T00:00:00.000Z", kw: ["arm64 build"] });
    const plan = proposeCluster([older, newer], [older, newer], new Map(), []);
    expect(plan.survivor.ts).toBe(newer.ts);
    expect(plan.merged.content).toBe(B);
    // Absorbed vocabulary rides along as keywords, capped, and it is what makes
    // the reads of the absorbed row keep landing.
    expect(plan.merged.kw!.length).toBeLessThanOrEqual(MAX_MERGED_KW);
    expect(plan.merged.kw).toContain("arm64 build");
    expect(plan.merged.kw!.length).toBeGreaterThan(0);
    expect(plan.merged.tags).toContain("consolidated");
    expect(plan.losers.map((m) => m.ts)).toEqual([older.ts]);
  });
});

describe("the acceptance rule: reads must survive", () => {
  const reads = [
    // A read that only the ABSORBED row's wording answers: "without extra flags
    // at all" is B's phrasing, and the terms come from the ledger.
    { terms: ["flimflam", "pipeline", "flags"], rows: [B] },
    { terms: ["arm64", "build", "box"], rows: [A, B] },
  ];

  test("a merge is proposed when the canonical row catches every read the cluster served", () => {
    const a = mem({ content: A, ts: "2026-06-01T00:00:00.000Z" });
    const b = mem({ content: B, ts: "2026-01-01T00:00:00.000Z" });
    const store = [a, b, mem({ content: C })];
    const asRows = reads.map((r) => ({
      terms: r.terms,
      rows: r.rows.map((text) => (text === A ? a.ts : b.ts)),
    }));
    const plan = proposeCluster(store, [b, a], new Map(), asRows);
    expect(plan.reads.length).toBe(2);
    expect(plan.bestMemberBefore).toBe(2);
    expect(plan.readsAfter).toBe(2);
    expect(plan.accepted).toBe(true);
    expect(plan.reasons).toEqual([]);
  });

  test("an UNMEASURED cluster is never proposed — no reads, no merge", () => {
    const a = mem({ content: A });
    const b = mem({ content: B });
    const plan = proposeCluster([a, b], [a, b], new Map(), []);
    expect(plan.accepted).toBe(false);
    expect(plan.reasons.join(" ")).toInclude("unmeasured");
  });

  test("readsFor only gathers reads that credited a member of this cluster", () => {
    const a = mem({ content: A });
    const b = mem({ content: B });
    const unrelated = mem({ content: C });
    const all = [
      { terms: ["flimflam"], rows: [a.ts] },
      { terms: ["zebra"], rows: [unrelated.ts] },
    ];
    expect(readsFor([a, b], all).length).toBe(1);
  });

  test("the pass drops proposals that fail the rule and reports the budget win", () => {
    const a = mem({ content: A, ts: "2026-06-01T00:00:00.000Z" });
    const b = mem({ content: B, ts: "2026-01-01T00:00:00.000Z" });
    const store = [a, b, mem({ content: C })];
    const reads = [{ terms: ["arm64", "build", "box"], rows: [a.ts] }];
    const report = proposeConsolidations(store, new Map(), reads);
    expect(report.plans.length).toBe(1);
    expect(report.rowsBefore).toBe(3);
    expect(report.rowsAfter).toBe(2);
    // One row leaves the injected budget, and the canonical row does not grow:
    // keywords are indexed, never rendered (#40).
    expect(report.injectedAfter).toBeLessThan(report.injectedBefore);
  });
});

describe("proposal rendering", () => {
  test("every proposal ends with the exact memory_merge_review call that resolves it", () => {
    const a = mem({ content: A, ts: "2026-06-01T00:00:00.000Z" });
    const b = mem({ content: B, ts: "2026-01-01T00:00:00.000Z" });
    const report = proposeConsolidations(
      [a, b],
      new Map(),
      [{ terms: ["arm64", "build", "box"], rows: [a.ts] }],
    );
    const text = renderProposals(report);
    expect(text).toContain("nothing was written");
    expect(text).toContain(`memory_merge_review(loser="${b.ts}"`);
    expect(text).toContain(`survivor="${a.ts}"`);
    expect(text).toContain("2 rows → 1");
    expect(text).toContain("STORE  2 rows → 1");
  });

  test("an empty report says nothing qualified, rather than saying nothing", () => {
    const text = renderProposals({
      plans: [],
      rowsBefore: 4,
      rowsAfter: 4,
      injectedBefore: 100,
      injectedAfter: 100,
    });
    expect(text).toContain("none");
  });
});
