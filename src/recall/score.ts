// score — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
import { loadAll } from "../store/files/load.ts"
import { type Memory } from "../store/model/memory.ts"
import { isInjectable } from "../store/model/predicates.ts";
import { cmpTs } from "../core/cmp-ts.ts";
import { type UseSignals, useBoost } from "./relevant.ts";

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
}

// Query-side stopwords: bag-of-words scoring has no IDF, so "the/what/how"
// match a large share of every memory and let a query with ZERO content
// overlap rank. Dropping them makes the matcher abstain — inject nothing — when the vocabulary
// genuinely has nothing in common, instead of injecting confident noise.
// Memory-side tokens are never filtered: a memory stating "the" must not
// gain or lose rank from it, only queries drive matching.
export const QUERY_STOPWORDS = new Set(
  "a an and are at be but by can did do does for from had has have how i in into is it its me my no not of on or our so than that the their them then there these they this to us was we were what when where which who why will with you your run runs getting want needs right back yet also just still ever should would could might may must shall ought nothing something anything everything thing things".split(" "),
);

// A free-text prompt long enough to carry >= this many content tokens must
// share >= 2 distinct concepts with a memory to inject: with a long query
// vocabulary, one shared token is near-certain coincidence (a live store hit
// injected a git memory on the word "should", df=1). A keyword-length query
// is a deliberate search — one shared concept suffices. memory_recall and the
// contextual pull keep single-overlap matches reachable; injection just stays
// quiet unless the vocabulary genuinely agrees twice.
const LONG_QUERY_TOKENS = 3;

// Production relevance ranking. Candidates must clear the concept-overlap
// gate, then rank by Robertson-IF of the shared tokens (rare concepts beat
// piles of common ones — the same idf form the bench's BM25 row uses).
// Ties break deliberately, in this order: open threads first (a pinned frontier
// row beats an equal-scoring settled one — that is what the frontier is for),
// then rows the use ledger has actually retrieved, most-recently-used first
// (#42 reinforcement), then the newer row (#40 item 2: between two equally
// relevant facts, the one stating what is true NOW is the better guess;
// epoch-freeze-safe because ts never changes for a given row).
// The haystack is `scope + type + content + kw`, where `kw` are the
// author-supplied aliases indexed at write time (#40 item 3, the vocabulary
// bridge for the bench's strict-paraphrase wall). Keywords are indexed, never
// rendered, so they cannot change what a block costs.
// Exported for bench/recall-quality.ts — the benchmark measures the shipped
// matcher.
//
// Superseded rows are dropped HERE, not only by the callers. Every model-facing
// sink already passes isInjectable() rows, but a scorer that can be handed a raw
// loadAll() result must not be the one place a retired memory leaks back into
// an injected block (#43 item 1: forbidden hits). The drop also keeps a
// retired row from diluting the document frequencies the ranking depends on.
export function scoreMemories(
  term: string,
  mems: Memory[],
  limit: number,
  use?: UseSignals,
): Memory[] {
  const live = mems.filter(isInjectable);
  const query = new Set(words(term).filter((t) => !QUERY_STOPWORDS.has(t)));
  if (!query.size) return [];
  const needShared = query.size >= LONG_QUERY_TOKENS ? 2 : 1;
  const hays = live.map((m) => new Set(words(haystack(m))));
  const df = new Map<string, number>();
  for (const h of hays) for (const t of h) df.set(t, (df.get(t) ?? 0) + 1);
  const n = live.length || 1;
  return live
    .map((m, i) => {
      let shared = 0;
      let score = 0;
      for (const w of query)
        if (hays[i]!.has(w)) {
          shared++;
          const d = df.get(w) ?? 0;
          score += Math.log(1 + (n - d + 0.5) / (d + 0.5));
        }
      return { m, shared, score };
    })
    .filter((s) => s.shared >= needShared)
    .sort(
      (a, b) =>
        b.score - a.score ||
        openRank(b.m) - openRank(a.m) ||
        useBoost(b.m, use) - useBoost(a.m, use) ||
        cmpTs(use?.get(b.m.ts)?.last ?? "", use?.get(a.m.ts)?.last ?? "") ||
        cmpTs(b.m.ts, a.m.ts),
    )
    .slice(0, limit)
    .map((s) => s.m);
}

// What a row is matched against. Kept in one place so the bench's arms and
// production can never disagree about the indexed fields.
export function haystack(m: Memory): string {
  return `${m.scope} ${m.type} ${m.content}${m.kw?.length ? ` ${m.kw.join(" ")}` : ""}`;
}

function openRank(m: Memory): number {
  return m.status === "open" ? 1 : 0;
}

export function omittedLine(count: number): string {
  return `+ ${count} open ${count === 1 ? "thread" : "threads"} omitted: over budget`;
}
