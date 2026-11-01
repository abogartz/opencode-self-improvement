// Recall-quality benchmark — the published keyword-adequacy defense.
// Question: at realistic store sizes, how often does the SHIPPED token matcher
// fail to rank the right memory inside the injection window (k=3), and how
// much of the gap closes with pure-algorithm changes — NO models, NO
// embeddings, NO inference engines, same zero-dependency guarantee the plugin
// ships with. The rank() seam is where anyone could add a vector scorer; the
// project's position is that a user should never be required to.
//
// Scorers:
//   naive — the previous shipped matcher (verbatim inline copy, kept as
//           the honest "before"): bag-of-words with no query stopword filter.
//   prod  — the CURRENT shipped matcher (imported from src/inject.ts):
//           identical scoring plus query-side stopword abstention, run against
//           the store WITHOUT keywords, i.e. what ships today for rows written
//           before #40.
//   prod+kw — the same shipped matcher, run against the same store with each
//           row's write-time `kw` aliases indexed. The one variable is the
//           index, so the delta is the vocabulary bridge and nothing else.
//   bm25  — Okapi BM25, k1=1.2 b=0.75, fixed literature defaults, chosen and
//           frozen BEFORE the eval; never tuned against it.
//
// Negative controls (#43, item 5). Silica's rule: "a metric that cannot fail
// reports PASS regardless of the arm". The control arms below are DELIBERATELY
// wrong (store order, reverse-of-naive) and are published alongside the real
// arms, so the table proves the metric ranks rather than always passing.
// test/negative-eval.test.ts turns that into an assertion, which is what makes
// the numbers falsifiable: if a control ever catches up with prod, the eval is
// broken and the test goes red.
//
// Efficiency (#40, item 4): accuracy is also reported per 1k INJECTED
// characters, using the real renderer (formatMemory) over the real injection
// window, because a matcher that buys recall by talking more is not free.
// Abstention counts as a miss and costs zero characters — the honest asymmetry.
//
// Query classes (lexical/near/strict) are assigned by MEASURED token overlap
// with the gold memory, not by the dataset author's intent. Deterministic:
// byte-identical output per run (fixed LCG, no Date.now, stable sorts).
//
//   bun bench/recall-quality.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatMemory } from "../src/inject/format.ts"
import { scoreMemories, words } from "../src/recall/score.ts";
import type { Memory } from "../src/store/model/memory.ts";
import { buildStore, KEYWORDS, keywordsFor, MEMORIES, QUERIES } from "./recall-dataset.ts";

/** Production injection window: the block shows at most this many rows. */
export const INJECT_K = 3;

export type Rank = (query: string, mems: Memory[]) => Memory[];

function asMemory(type: string, scope: string, content: string, kw?: string[]): Memory {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    type,
    scope,
    content,
    ...(kw?.length ? { kw } : {}),
    status: "settled",
    file: "",
    index: 0,
  };
}

// naive: pre-stopword-filter shipped matcher, kept verbatim as the baseline.
export const naive: Rank = (query, mems) => {
  const q = new Set(words(query));
  return mems
    .map((m) => {
      const hay = new Set(words(`${m.scope} ${m.type} ${m.content}`));
      let score = 0;
      for (const w of q) if (hay.has(w)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.m);
};

export const prod: Rank = (query, mems) => scoreMemories(query, mems, mems.length);

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export function bm25Rank(query: string, mems: Memory[]): Memory[] {
  const docs = mems.map((m) => words(`${m.scope} ${m.type} ${m.content}`));
  const N = docs.length || 1;
  const avgdl = docs.reduce((a, d) => a + d.length, 0) / N;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(words(query))];
  const scored = mems.map((m, i) => {
    const tf = new Map<string, number>();
    for (const t of docs[i]!) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = docs[i]!.length;
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const dft = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - dft + 0.5) / (dft + 0.5));
      s += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl))));
    }
    return { m, s };
  });
  return scored.sort((a, b) => b.s - a.s).filter((x) => x.s > 0).map((x) => x.m);
}

// --- negative controls --------------------------------------------------------
// Both arms ignore the gold on purpose. They exist so the eval can FAIL: a
// metric under which a random or inverted ranking scores like the shipped one
// is not measuring retrieval.

/** Ignores the query entirely: always the first k rows of the store. */
export const constantArm: Rank = (_query, mems) => mems.slice(0, INJECT_K);

/** The naive arm's ranking read backwards — worst-first by construction. */
export const antiNaive: Rank = (query, mems) => naive(query, mems).reverse();

export const CONTROL_ARMS: Record<string, Rank> = {
  constant: constantArm,
  "anti-naive": antiNaive,
};

// --- classification by measured overlap (anti-rigging rule 1) ------------------

// Stopwords ONLY for LABELING the class; every scorer runs as it ships.
const STOP = new Set(
  "a an and are at be but by can did do does for from had has have how i in into is it its me my no not of on or our so than that the their them then there these they this to us was we were what when where which who why will with you your run runs getting want needs right back yet also just still ever".split(" "),
);

const goldById = new Map(MEMORIES.map((m) => [m.id, m]));

function contentTokens(text: string): Set<string> {
  return new Set(words(text).filter((t) => !STOP.has(t)));
}

export type QClass = "lexical" | "near" | "strict";
export function measureClass(query: string, gold: string): QClass {
  const g = goldById.get(gold)!;
  const gt = contentTokens(`${g.scope} ${g.type} ${g.content}`);
  let shared = 0;
  for (const t of contentTokens(query)) if (gt.has(t)) shared++;
  return shared >= 2 ? "lexical" : shared === 1 ? "near" : "strict";
}

export interface StoreRows {
  rows: Memory[];
  gold: Map<string, Memory>;
}

export type StoreIndex = "none" | "kw" | "shuffled";

// Deterministic mis-assignment: every row gets ANOTHER memory's keyword set
// (rotate by a fixed offset). It is the control that the "no keyword may
// resemble a query" rule could never be — that rule cannot tell authorship
// from honest synonymy, whereas this one measures whether the bridge earns its
// gain from MEANING or merely from extra tokens. If a store full of plausible
// but wrong aliases scored like the real ones, the `kw` number would be noise.
const SHUFFLE_OFFSET = 7;
const KW_IDS = Object.keys(KEYWORDS);

function indexedKeywordsFor(id: string, mode: StoreIndex): string[] | undefined {
  if (mode === "none") return undefined;
  if (mode === "kw") return keywordsFor(id);
  const base = id.split("#")[0]!;
  const i = KW_IDS.indexOf(base);
  if (i === -1) return undefined;
  return KEYWORDS[KW_IDS[(i + SHUFFLE_OFFSET) % KW_IDS.length]!];
}

/**
 * The store at `size` as Memory rows.
 * `none` reproduces the pre-#40 index (what every stored row looks like
 * today); `kw` indexes each row's authored aliases; `shuffled` indexes the
 * same number of alias tokens with the wrong meanings.
 */
export function storeAt(size: number, index: StoreIndex = "none"): StoreRows {
  const store = buildStore(size);
  const row = (m: (typeof store)[number]) =>
    asMemory(m.type, m.scope, m.content, indexedKeywordsFor(m.id, index));
  return { rows: store.map(row), gold: new Map(store.map((m) => [m.id, row(m)])) };
}

/**
 * Characters an injection block would cost for this ranking: the rows inside
 * the production window, rendered exactly as src/inject.ts renders them, plus
 * the newline between them. An empty ranking (abstention) costs nothing.
 */
export function injectedChars(rank: Memory[]): number {
  return rank.slice(0, INJECT_K).reduce((a, m) => a + formatMemory(m).length + 1, 0);
}

export interface ClassScore {
  n: number;
  r1: number;
  r3: number;
  silent: number;
  injectedChars: number;
}

export interface ArmScore {
  n: number;
  r1: number;
  r3: number;
  silent: number;
  injectedChars: number;
  byClass: Record<QClass, ClassScore>;
}

const emptyClass = (): ClassScore => ({ n: 0, r1: 0, r3: 0, silent: 0, injectedChars: 0 });

/**
 * Score ONE arm over every query whose gold is in the store. Used by the
 * published control table and pinned by test/negative-eval.test.ts, so the
 * "can this metric fail?" question is an assertion, not a comment.
 */
export function scoreArm(size: number, rank: Rank, index: StoreIndex = "none"): ArmScore {
  const { rows, gold } = storeAt(size, index);
  const score: ArmScore = {
    n: 0,
    r1: 0,
    r3: 0,
    silent: 0,
    injectedChars: 0,
    byClass: { lexical: emptyClass(), near: emptyClass(), strict: emptyClass() },
  };
  for (const { q, gold: goldId } of QUERIES) {
    const goldMem = gold.get(goldId);
    if (!goldMem) continue; // gold not in this store
    const list = rank(q, rows);
    const idx = list.findIndex((m) => m.content === goldMem.content);
    const cls = measureClass(q, goldId);
    const tally = (c: ClassScore) => {
      c.n++;
      if (idx === 0) c.r1++;
      if (idx >= 0 && idx < INJECT_K) c.r3++;
      if (!list.length) c.silent++;
      c.injectedChars += injectedChars(list);
    };
    score.n++;
    if (idx === 0) score.r1++;
    if (idx >= 0 && idx < INJECT_K) score.r3++;
    if (!list.length) score.silent++;
    score.injectedChars += injectedChars(list);
    tally(score.byClass[cls]);
  }
  return score;
}

// --- metrics -------------------------------------------------------------------

interface Row {
  cls: QClass;
  n: number;
  naiveR3: number;
  prodR1: number;
  prodR3: number;
  bm25R1: number;
  bm25R3: number;
  prodRecovers: number; // naive missed top-3, prod landed it
  bm25Recovers: number; // prod missed top-3, bm25 landed it
  allMiss: number; // the residual vocabulary wall (prod AND bm25 miss)
  silent: number; // prod abstains entirely (no block injected — noise avoided)
  // #40: the same matcher with write-time keywords indexed.
  kwR1: number;
  kwR3: number;
  kwRecovers: number; // prod missed top-3, prod+kw landed it
  kwSilent: number;
  // Injected characters inside the window (the real cost of each arm).
  charsProd: number;
  charsKw: number;
  charsNaive: number;
  charsBm25: number;
}

export function evaluate(size: number) {
  const store = buildStore(size);
  const mems = storeAt(size, "none").rows;
  const memsKw = storeAt(size, "kw").rows;
  const byClass = new Map<QClass, Row>();
  let noiseNaive = 0;
  let noiseProd = 0;
  let noiseKw = 0;
  for (const { q, gold } of QUERIES) {
    const goldMem = store.find((m) => m.id === gold);
    if (!goldMem) continue; // gold not in this store
    const cls = measureClass(q, gold);
    const r = byClass.get(cls) ?? {
      cls, n: 0, naiveR3: 0, prodR1: 0, prodR3: 0, bm25R1: 0, bm25R3: 0,
      prodRecovers: 0, bm25Recovers: 0, allMiss: 0, silent: 0,
      kwR1: 0, kwR3: 0, kwRecovers: 0, kwSilent: 0,
      charsProd: 0, charsKw: 0, charsNaive: 0, charsBm25: 0,
    };
    const nv = naive(q, mems);
    const p = prod(q, mems);
    const k = prod(q, memsKw);
    const b = bm25Rank(q, mems);
    const in3 = (list: Memory[]) => {
      const i = list.findIndex((m) => m.content === goldMem.content);
      return i >= 0 && i < INJECT_K;
    };
    r.n++;
    if (in3(nv)) r.naiveR3++;
    if (p[0]?.content === goldMem.content) r.prodR1++;
    if (in3(p)) r.prodR3++;
    if (b[0]?.content === goldMem.content) r.bm25R1++;
    if (in3(b)) r.bm25R3++;
    if (k[0]?.content === goldMem.content) r.kwR1++;
    if (in3(k)) r.kwR3++;
    if (!in3(nv) && in3(p)) r.prodRecovers++;
    if (!in3(p) && in3(b)) r.bm25Recovers++;
    if (!in3(p) && in3(k)) r.kwRecovers++;
    if (!in3(p) && !in3(b)) r.allMiss++;
    if (p.length === 0) r.silent++;
    if (k.length === 0) r.kwSilent++;
    if (nv.length && nv[0]!.content !== goldMem.content) noiseNaive++;
    if (p.length && p[0]!.content !== goldMem.content) noiseProd++;
    if (k.length && k[0]!.content !== goldMem.content) noiseKw++;
    r.charsNaive += injectedChars(nv);
    r.charsProd += injectedChars(p);
    r.charsKw += injectedChars(k);
    r.charsBm25 += injectedChars(b);
    byClass.set(cls, r);
  }
  return { rows: r2list(byClass), noiseNaive, noiseProd, noiseKw };
}

function r2list(m: Map<QClass, Row>): Row[] {
  return (["lexical", "near", "strict"] as QClass[]).map((c) => m.get(c)!).filter(Boolean);
}

const pct = (hit: number, n: number) => (n ? `${Math.round((hit / n) * 100)}%` : "-");
const per1k = (hits: number, chars: number) =>
  chars > 0 ? (hits / (chars / 1000)).toFixed(2) : "—";

const SIZES = [50, 200, 500];

function report(): string {
  const lines: string[] = [];
  lines.push("# Recall quality: shipped matcher vs alternatives (zero dependencies, zero models)");
  lines.push("");
  lines.push(
    `Dataset: ${MEMORIES.length} gold memories, ${QUERIES.length} queries; classes assigned by ` +
      "MEASURED token overlap with the gold (>=2 shared content tokens = lexical, 1 = near, " +
      "0 = strict paraphrase). k=3 mirrors the production injection limit. BM25 k1=1.2 b=0.75 " +
      "fixed before the eval. naive = previous shipped matcher; prod = current shipped " +
      "matcher (query-side stopword abstention, two-concept evidence gate for free-text " +
      "queries, IDF-weighted ranking, recency tie-break); prod+kw = the same matcher with each " +
      "row's authored write-time `kw` aliases indexed (bench/recall-dataset.ts records the " +
      "authoring rule: keywords come from the memory's own content, never from the queries).",
  );
  lines.push("");

  for (const size of SIZES) {
    const { rows, noiseNaive, noiseProd, noiseKw } = evaluate(size);
    lines.push(`## Store size ${size}`);
    lines.push("");
    lines.push("| Query class | n | naive R@3 | prod R@1 | prod R@3 | BM25 R@1 | BM25 R@3 | prod recovers | BM25 recovers | all miss | prod abstains |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    const tot = { n: 0, nv: 0, p1: 0, p3: 0, b1: 0, b3: 0, pr: 0, rec: 0, miss: 0, sil: 0 };
    for (const r of rows) {
      tot.n += r.n; tot.nv += r.naiveR3; tot.p1 += r.prodR1; tot.p3 += r.prodR3;
      tot.b1 += r.bm25R1; tot.b3 += r.bm25R3; tot.pr += r.prodRecovers; tot.rec += r.bm25Recovers;
      tot.miss += r.allMiss; tot.sil += r.silent;
      lines.push(
        `| ${r.cls} | ${r.n} | ${pct(r.naiveR3, r.n)} | ${pct(r.prodR1, r.n)} | ${pct(r.prodR3, r.n)} | ` +
          `${pct(r.bm25R1, r.n)} | ${pct(r.bm25R3, r.n)} | ${r.prodRecovers} | ${r.bm25Recovers} | ${r.allMiss} | ${r.silent} |`,
      );
    }
    lines.push(
      `| **all** | ${tot.n} | ${pct(tot.nv, tot.n)} | ${pct(tot.p1, tot.n)} | ${pct(tot.p3, tot.n)} | ` +
        `${pct(tot.b1, tot.n)} | ${pct(tot.b3, tot.n)} | ${tot.pr} | ${tot.rec} | ${tot.miss} | ${tot.sil} |`,
    );
    lines.push("");
    lines.push(
      `Wrong-memory-first (top-1 noise): naive ${pct(noiseNaive, QUERIES.length)} -> ` +
        `prod ${pct(noiseProd, QUERIES.length)} -> prod+kw ${pct(noiseKw, QUERIES.length)}.`,
    );
    lines.push("");

    lines.push("Vocabulary bridge — same matcher, `kw` aliases indexed (the strict wall is what it attacks):");
    lines.push("");
    lines.push("| Query class | n | prod R@1 | prod+kw R@1 | prod R@3 | prod+kw R@3 | kw recovers | prod abstains | prod+kw abstains |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    const kt = { n: 0, p1: 0, k1: 0, p3: 0, k3: 0, rec: 0, sil: 0, silKw: 0 };
    for (const r of rows) {
      kt.n += r.n; kt.p1 += r.prodR1; kt.k1 += r.kwR1; kt.p3 += r.prodR3; kt.k3 += r.kwR3;
      kt.rec += r.kwRecovers; kt.sil += r.silent; kt.silKw += r.kwSilent;
      lines.push(
        `| ${r.cls} | ${r.n} | ${pct(r.prodR1, r.n)} | ${pct(r.kwR1, r.n)} | ${pct(r.prodR3, r.n)} | ` +
          `${pct(r.kwR3, r.n)} | ${r.kwRecovers} | ${r.silent} | ${r.kwSilent} |`,
      );
    }
    lines.push(
      `| **all** | ${kt.n} | ${pct(kt.p1, kt.n)} | ${pct(kt.k1, kt.n)} | ${pct(kt.p3, kt.n)} | ` +
        `${pct(kt.k3, kt.n)} | ${kt.rec} | ${kt.sil} | ${kt.silKw} |`,
    );
    lines.push("");

    lines.push("Efficiency — R@3 hits per 1k injected characters (window k=3; abstention = a miss that costs nothing):");
    lines.push("");
    lines.push(
      "> How to read this: a matcher that abstains spends no characters, so its ratio flatters it — prod's " +
        "decent per-1k next to a 0% R@3 IS the abstention strategy: few bytes, few answers, and a turn that " +
        "learned nothing. Read hits-per-1k together with total characters: the bridge costs roughly 30% more " +
        "injected bytes at store 200 (~60% at 50) and returns slightly MORE hits per 1k than abstention, " +
        "because the bytes it does spend land on rows that answer.",
    );
    lines.push("");
    lines.push("| Query class | n | chars prod | chars prod+kw | naive /1k | prod /1k | prod+kw /1k | BM25 /1k |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    const et = { n: 0, cp: 0, ck: 0, cn: 0, cb: 0, p3: 0, k3: 0, nv3: 0, b3: 0 };
    for (const r of rows) {
      et.n += r.n; et.cp += r.charsProd; et.ck += r.charsKw; et.cn += r.charsNaive; et.cb += r.charsBm25;
      et.p3 += r.prodR3; et.k3 += r.kwR3; et.nv3 += r.naiveR3; et.b3 += r.bm25R3;
      lines.push(
        `| ${r.cls} | ${r.n} | ${r.charsProd} | ${r.charsKw} | ${per1k(r.naiveR3, r.charsNaive)} | ` +
          `${per1k(r.prodR3, r.charsProd)} | ${per1k(r.kwR3, r.charsKw)} | ${per1k(r.bm25R3, r.charsBm25)} |`,
      );
    }
    lines.push(
      `| **all** | ${et.n} | ${et.cp} | ${et.ck} | ${per1k(et.nv3, et.cn)} | ${per1k(et.p3, et.cp)} | ` +
        `${per1k(et.k3, et.ck)} | ${per1k(et.b3, et.cb)} |`,
    );
    lines.push("");

    lines.push("Negative controls (the metric must rank, not always pass):");
    lines.push("");
    lines.push("| Arm | R@1 | R@3 |");
    lines.push("| --- | ---: | ---: |");
    const controlRows: Array<[string, Rank, StoreIndex, boolean]> = [
      ["prod (shipped)", prod, "none", false],
      ["prod + authored kw", prod, "kw", false],
      ["naive (previous)", naive, "none", false],
      ["prod + shuffled kw (control: same tokens, wrong meanings)", prod, "shuffled", true],
      ["constant (control)", constantArm, "none", true],
      ["anti-naive (control)", antiNaive, "none", true],
    ];
    for (const [name, arm, index, control] of controlRows) {
      const s = scoreArm(size, arm, index);
      lines.push(
        `| ${name}${control ? ", must be lower than prod" : ""} | ${pct(s.r1, s.n)} | ${pct(s.r3, s.n)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const out = report();
  process.stdout.write(out);
  writeFileSync(join(import.meta.dir, "recall-results.md"), out);
}
