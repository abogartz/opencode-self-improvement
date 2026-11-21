// Near-duplicate suppression inside a returned window: one deterministic pass
// AFTER ranking.
//
// Skip a candidate whose content-token Jaccard against an already-kept row of
// the same scope reaches the threshold; the NEWEST copy of a clash takes the
// slot, because the duplicates in a live store are stale cursors and
// superseded snapshots. ON by default at 0.8; OPENCODE_MEMORY_DEDUP=0 returns
// the plain top-limit slice, byte-identical to no pass. A value below 0.5 or
// above 1, or one that is not a number, is a misconfiguration and turns the
// pass off.
//
// Guards, each pinned by a test:
// - Compare content tokens only. Type and scope are not tokens: same-scope
//   rows would share two free tokens and short rows would look alike.
// - A pair where exactly one row carries a negation word is never a copy:
//   "force push main" inside "never force push main" reaches Jaccard 0.833 and
//   the wrong copy would survive.
// - A row under MIN_CONTENT content tokens is never suppressed; non-Latin
//   prose tokenises to nothing and there is nothing to compare.
// - A pair whose numeric literals differ is never a copy: short tokens are
//   dropped, so "DB 3" and "DB 4" otherwise share identical token sets.
//
// A clash is not one situation. Either one row corrected the other, or the two
// rows name two things that both hold, and only the first is a copy. A row
// whose tokens are wholly contained in its partner names something the partner
// does not restate, so both are kept and reported as a group; the others still
// collapse to the newest. OPENCODE_MEMORY_AMBIGUOUS=0 restores the collapse for
// every class.
//
// Threshold guidance: 0.5-0.7 suppresses merely-related rows and forces the
// window deep into the ranking; 0.8 suppresses near-identical copies only.
// History and measurements: docs/adr/0002.
import type { Memory } from "../store/model/memory.ts";
import { words } from "./score.ts";

export const DEDUPE_ENV = "OPENCODE_MEMORY_DEDUP";

/**
 * Keeps an additive clash instead of collapsing it. Independent of
 * DEDUPE_ENV: `OPENCODE_MEMORY_DEDUP=0` turns the whole pass off, and this flag
 * only chooses what a clash does when the pass is on.
 */
export const AMBIGUOUS_ENV = "OPENCODE_MEMORY_AMBIGUOUS";

/** Below this, the value is a misconfiguration and the pass stays off. */
export const MIN_THRESHOLD = 0.5;

/** A row with fewer content tokens than this is never compared (§17 floor). */
export const MIN_CONTENT = 4;

/**
 * The default when the flag is unset: 0.8 is the live-replay point that
 * suppresses only near-identical copies (§17) — it touched 17% of calls,
 * never changed top-1, and never dropped a term's last carrier.
 */
export const DEFAULT_THRESHOLD = 0.8;

/**
 * Tokens that reverse a row's meaning. If exactly one row of a candidate pair
 * carries any of them, the rows disagree, and disagreement is not duplication.
 * Only words that survive `words()` (lower-case, length > 2) are listed;
 * contractions split ("don't" yields "don"), which is why "don" appears.
 */
export const POLARITY_WORDS = new Set([
  "never",
  "not",
  "cannot",
  "cant",
  "dont",
  "don",
  "avoid",
  "forbidden",
  "prohibited",
  "banned",
]);

/**
 * Threshold from the environment. Unset or empty means DEFAULT_THRESHOLD (on).
 * `0` means off — the documented escape hatch. An explicit value that is
 * unparsable, < MIN_THRESHOLD or > 1 is a misconfiguration and turns the pass
 * off rather than silently running something the user did not ask for.
 */
export function dedupeThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[DEDUPE_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_THRESHOLD && n <= 1 ? n : 0;
}

/**
 * Whether an additive clash keeps both rows. On unless AMBIGUOUS_ENV says
 * otherwise; only `0`, `off` and `false` disable it, so a typo cannot turn the
 * behavior off by accident the way an unparsable threshold does.
 */
export function ambiguousEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[AMBIGUOUS_ENV];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false");
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** What a near-duplicate clash actually is. */
export type PairClass = "identical" | "addition" | "substitution";

/**
 * Whether one row restates its partner or names something the partner does not.
 * The leftover token sets decide, and the two situations are opposite:
 *
 * - `identical` — nothing left over either way, one row typed twice.
 * - `addition` — one side wholly contained. The rows name different things and
 *   both hold; `build:example-images` tokenises to contain `build`, which is
 *   how a second command reaches 0.82 against the first.
 * - `substitution` — a leftover on each side, read as the same statement
 *   about a changed world, so the older row is stale.
 *
 * Only `addition` is decidable from containment. Its absence is NOT evidence
 * of a correction: two instructions naming two scripts that both exist
 * (`bun run bench:recall` and `bun run bench:write`) also leave a leftover on
 * each side, score 0.882, and the older is dropped. That limitation predates
 * this rule and is recorded in docs/adr/0002; collapsing such a pair is the
 * pass's existing behavior, not something the split introduces.
 *
 * Only token equality, so the short-chunk guard stays load-bearing: "late 0"
 * and "late 1" tokenise alike and read as `identical` here.
 */
export function classifyPair(a: Set<string>, b: Set<string>): PairClass {
  let onlyA = 0;
  for (const t of a) if (!b.has(t)) onlyA++;
  if (onlyA === 0) return a.size === b.size ? "identical" : "addition";
  let onlyB = 0;
  for (const t of b) if (!a.has(t)) onlyB++;
  return onlyB === 0 ? "addition" : "substitution";
}

/**
 * The short tokens `words()` drops (chunks of length <= 2). They are where
 * single-digit facts hide: "Rate limiter reads Redis DB 3." and "...DB 4."
 * have identical token sets and reach Jaccard 1. Timestamped
 * cursor rows — the rows this pass exists to suppress — keep their digit
 * groups inside longer tokens ("15z"), so comparing the dropped chunks only
 * guards real fact changes without touching the cursor case. A pair whose
 * dropped chunks differ is never a copy.
 */
export function droppedChunks(content: string): string[] {
  return content
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0 && t.length <= 2)
    .sort();
}

/** True when two rows carry the same short chunks (same multiset). */
function sameDroppedChunks(a: Memory, b: Memory): boolean {
  const na = droppedChunks(a.content);
  const nb = droppedChunks(b.content);
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) if (na[i] !== nb[i]) return false;
  return true;
}

/**
 * A row's own tokens: built DIRECTLY from the content and keyword fields.
 * Never from `haystack()` — the identifier tokenizer splits a multi-word scope
 * into its parts, and those parts stand in for content. Any delimiter does it:
 * `auth_token_refresh_policy` and `auth-token-refresh-policy` both yield
 * auth/token/refresh/policy, so a store holding no underscore is not exempt.
 * Deleting only the whole scope/type strings leaves those words standing in
 * for content: two unrelated non-Latin rows in one scope then share a
 * Jaccard-1 metadata vocabulary, clear MIN_CONTENT on scope tokens alone,
 * and dedup hides one.
 */
export function contentTokens(m: Memory): Set<string> {
  const text = m.content + (m.kw?.length ? ` ${m.kw.join(" ")}` : "");
  return new Set(words(text));
}

function hasPolarity(tokens: Set<string>): boolean {
  for (const w of tokens) if (POLARITY_WORDS.has(w)) return true;
  return false;
}

/**
 * A window plus the additive families inside it: rows kept side by side because
 * each names something the others do not restate. A family is a SET, not a pair.
 * With three rows that all overlap, every pair inside them is additive, and one
 * marker per pair prints ten lines for five facts — all repeating the same
 * Action. One line per family says what the reader needs: these rows belong
 * together and none of them supersedes another.
 */
export interface GroupedWindow {
  rows: Memory[];
  groups: Memory[][];
}

/**
 * Keep at most `limit` rows from `ranked`, in ranking order, skipping a row
 * when it is a near-copy (same scope, content-token Jaccard >= `threshold`) of
 * a row already kept. When a clash happens the NEWER row takes the slot —
 * §17: the duplicates are stale snapshots, so recency decides, not rank. Rows
 * under `MIN_CONTENT` content tokens, pairs that disagree on a negation word,
 * and pairs whose numeric literals differ are never suppressed. `threshold <= 0`
 * returns the plain top-`limit` slice, so the flag-off path costs nothing and
 * cannot reorder.
 *
 * With `groupAdditions` an `addition` clash keeps both rows and is reported in
 * `groups`, because the shorter row names something the longer one does not
 * restate. `groups` carries the rows themselves: a later clash overwrites a
 * slot in the window, and a group keyed on that slot would re-point at
 * whatever landed there.
 *
 * A candidate can win more than one collapse clash at once — a substitution of
 * one kept row and an exact copy of another. It then takes the first slot and
 * vacates the rest, because a row left standing beside the copy that replaced
 * it returns the same text twice and costs a distinct row its slot. The scan
 * only stops at the first clash with grouping off; with grouping on it walks
 * the whole window, so every clash is visible here.
 */
export function dedupeWindowGrouped(
  ranked: Memory[],
  limit: number,
  threshold: number,
  groupAdditions: boolean = ambiguousEnabled(),
): GroupedWindow {
  if (threshold <= 0 || ranked.length <= 1)
    return { rows: ranked.slice(0, limit), groups: [] };
  // Token sets are built lazily and cached per index: the loop stops once
  // `limit` rows are kept, so eager tokenization of every candidate costs
  // 1.7ms/12.5ms/96.4ms at 200/2k/10k candidates on every query recall.
  // Lazy cost is window-sized.
  const tokenCache = new Map<number, Set<string>>();
  const tokensOf = (i: number): Set<string> => {
    let t = tokenCache.get(i);
    if (t === undefined) {
      t = contentTokens(ranked[i]!);
      tokenCache.set(i, t);
    }
    return t;
  };
  const polarityCache = new Map<number, boolean>();
  const polarityOf = (i: number): boolean => {
    let p = polarityCache.get(i);
    if (p === undefined) {
      p = hasPolarity(tokensOf(i));
      polarityCache.set(i, p);
    }
    return p;
  };
  const kept: number[] = [];
  for (let i = 0; i < ranked.length && kept.length < limit; i++) {
    if (tokensOf(i).size < MIN_CONTENT) {
      kept.push(i);
      continue;
    }
    // With grouping off this is the pre-grouping rule verbatim: stop at the
    // FIRST clash and let recency decide, because a rollback flag that changes
    // which facts survive is not a rollback. With grouping on the scan walks
    // every kept row: an additive clash found early in the window can sit next
    // to its own exact copy later in it, and grouping on the first match spends
    // a slot on a duplicate while a distinct row waits outside — the exact loss
    // this pass exists to prevent. A collapse therefore outranks a group.
    let addition = -1; // first clash that names something new
    let collapse = -1; // FIRST clash that is a copy or a correction
    // Every collapse clash the candidate wins, not just the first. A row can
    // beat two kept rows in one pass and the two classes differ: it may be a
    // substitution of one and an exact copy of another. Taking only the first
    // slot leaves the copy it beat standing beside it, so the window returns
    // the same text twice and a distinct row outside never arrives.
    const beaten: number[] = [];
    // Collapse slots emptied because the candidate took their row's meaning.
    const vacated = new Set<number>();
    // A kept row the candidate loses to. One loss is enough to keep the
    // candidate out: the newest copy is the one that rides.
    let outranked = false;
    for (const pos of kept.keys()) {
      const k = kept[pos]!;
      if (
        ranked[k]!.scope !== ranked[i]!.scope ||
        tokensOf(k).size < MIN_CONTENT ||
        polarityOf(k) !== polarityOf(i) ||
        !sameDroppedChunks(ranked[k]!, ranked[i]!) ||
        jaccard(tokensOf(i), tokensOf(k)) < threshold
      ) {
        continue;
      }
      if (
        groupAdditions &&
        classifyPair(tokensOf(k), tokensOf(i)) === "addition"
      ) {
        if (addition < 0) addition = pos;
        continue;
      }
      if (!groupAdditions) {
        collapse = pos;
        break;
      }
      if (collapse < 0) collapse = pos;
      if (ranked[k]!.ts >= ranked[i]!.ts) outranked = true;
      else beaten.push(pos);
    }
    if (
      collapse < 0 &&
      addition >= 0 &&
      groupAdditions &&
      kept.length < limit
    ) {
      kept.push(i);
    } else if (collapse >= 0) {
      // Decided before any slot changes. A candidate that loses to a newer kept
      // row does not ride, so it must not overwrite the older row it also
      // beat: that would drop a row the candidate never outranked.
      // A winner takes the FIRST clashing slot, keeping its rank, and every
      // other slot it won is removed so the scan refills it.
      const rides = !outranked && ranked[i]!.ts > ranked[kept[collapse]!]!.ts;
      if (rides) {
        kept[collapse] = i;
        for (const pos of beaten) {
          if (pos !== collapse) vacated.add(pos);
        }
      }
    } else if (addition >= 0) {
      if (ranked[i]!.ts > ranked[kept[addition]!]!.ts) kept[addition] = i;
    } else kept.push(i);
    // Removed after the branch: `collapse` and `beaten` are positions inside
    // `kept`, and splicing mid-scan would move them.
    for (const pos of [...vacated].sort((a, b) => b - a)) kept.splice(pos, 1);
  }
  const rows = kept.map((i) => ranked[i]!);
  // Families are recomputed from the window instead of accumulated during the
  // pass. A collapse replaces a row in place, so a group recorded earlier can
  // name a row that no longer rides, and a marker pointing at an absent row
  // describes nothing. Recomputing also costs nothing: the window is `limit`
  // rows, so this is a handful of comparisons against cached token sets.
  const groups: Memory[][] = [];
  if (groupAdditions) {
    const additive = (x: number, y: number): boolean =>
      ranked[x]!.scope === ranked[y]!.scope &&
      tokensOf(x).size >= MIN_CONTENT &&
      tokensOf(y).size >= MIN_CONTENT &&
      polarityOf(x) === polarityOf(y) &&
      sameDroppedChunks(ranked[x]!, ranked[y]!) &&
      jaccard(tokensOf(x), tokensOf(y)) >= threshold &&
      classifyPair(tokensOf(x), tokensOf(y)) === "addition";
    const adj: number[][] = kept.map(() => []);
    for (let a = 0; a < kept.length; a++)
      for (let b = a + 1; b < kept.length; b++)
        if (additive(kept[a]!, kept[b]!)) {
          adj[a]!.push(b);
          adj[b]!.push(a);
        }
    // Connected components, in window order. Additivity is not transitive, but
    // a chain of additive rows is one explanation rather than n of them, and
    // the chain is what the reader is looking at. Everything in this block is a
    // POSITION within `kept`, not a row index — the last map is the only place
    // that crosses back, and getting it wrong names a row that was replaced.
    const seen = new Set<number>();
    for (let a = 0; a < kept.length; a++) {
      if (seen.has(a) || adj[a]!.length === 0) continue;
      seen.add(a);
      const stack = [a];
      const fam: number[] = [];
      while (stack.length) {
        const x = stack.pop()!;
        fam.push(x);
        for (const y of adj[x]!)
          if (!seen.has(y)) {
            seen.add(y);
            stack.push(y);
          }
      }
      groups.push(fam.sort((p, q) => p - q).map((pos) => ranked[kept[pos]!]!));
    }
  }
  return { rows, groups };
}

/** The window alone, without the groups. See `dedupeWindowGrouped`. */
export function dedupeWindow(
  ranked: Memory[],
  limit: number,
  threshold: number,
): Memory[] {
  return dedupeWindowGrouped(ranked, limit, threshold).rows;
}
