// #393 AC 2: check an inferred claim against the working tree BEFORE storing it.
//
// The scope is deliberately narrow, and the measurement is why it is narrow.
// R4's poison rows claimed a fallback VAT rate for a fixture whose config leaves
// that rate UNSET: `findConstant(base4, "fallbackVatBps")` returns null. The tree
// does not contradict the poison — it is silent, and silence is exactly where a
// confident wrong row fits.
//
//   - refusing when the tree CONTRADICTS a claim refuses nothing in R4;
//   - refusing when the tree is SILENT also refuses the transport fact
//     (empty store 0/5, seeded 5/5), which is the one measured benefit memory has.
//
// So this module answers three ways and only one of them refuses. "Undecidable"
// keeps the row — that is the transport case — and the row then rides injection
// labelled `[unverified]` (see store/model/provenance.ts), which is the part of
// #393 the evidence actually supports.

import { findConstant, valuesAgree } from "../recall/conflicts.ts";

export type ClaimVerdict = "agrees" | "contradicts" | "undecidable";

export interface ClaimHit {
  verdict: ClaimVerdict;
  /** The symbol the check resolved in the tree, when one resolved. */
  ref?: string;
  /** The number compared, when one was compared. */
  claim?: string;
}

// A constant the row names, in the two shapes source uses: SCREAMING_CASE and a
// dotted camelCase member. Deliberately narrow — prose that merely mentions
// "rate" must not be resolved against a symbol.
//
// Built per call, NOT shared at module scope. A `g` regex carries `lastIndex`
// between calls, so a shared one starts the next row's scan wherever the last
// one stopped and silently returns "undecidable" for a claim it would have
// caught. That is a check whose result depends on the order of previous rows —
// the worst shape a gate can have, because it looks deterministic.
function symbols(): RegExp {
  return /\b([A-Z][A-Z0-9_]{2,}|[A-Za-z_$][A-Za-z0-9_$]*\.[a-z][A-Za-z0-9_$]*)\b/g;
}
// How far after the symbol a number may sit and still count as THAT symbol's
// value. "VAT_BPS is 2150" yes; "VAT_BPS was added in 2024, the rate is 2150"
// compares 2024 and refuses on a coincidence, which is worse than not checking.
const WINDOW = 48;

/**
 * Check an inferred row's numeric claim against the working tree by reading the
 * claim OUT of its own prose.
 *
 * Capture's structured `ref`/`claim` fields ride user-guided rows only (see
 * `capture/candidates.ts`), and the guided rows are exactly the ones this check
 * must not touch — a user correcting a stale tree is the case where the tree is
 * wrong. So an inferred row is checked on what it says, not on what it declared.
 *
 * Agrees when one resolvable symbol's value matches a nearby number; contradicts
 * only when a resolvable symbol's value disagrees with EVERY number the row
 * states near it; undecidable otherwise, which is the transport case and keeps
 * the row.
 */
export function claimVerdictFromContent(
  repoDir: string | undefined,
  content: string,
): ClaimHit {
  if (!repoDir || !content) return { verdict: "undecidable" };
  const cache = new Map<string, string | undefined>();
  let sawResolvable = false;
  const SYMBOL = symbols();
  let match: RegExpExecArray | null = SYMBOL.exec(content);
  while (match) {
    const ref = match[1] ?? "";
    // Step past the whole match, not just the captured name: the `` lookahead
    // means a name-length advance would re-find the same symbol forever.
    SYMBOL.lastIndex = match.index + match[0].length;
    if (!cache.has(ref)) {
      const fact = findConstant(repoDir, ref);
      cache.set(ref, fact ? String(fact.value) : undefined);
    }
    const code = cache.get(ref);
    if (code !== undefined) {
      sawResolvable = true;
      const tail = content.slice(
        match.index + ref.length,
        match.index + ref.length + WINDOW,
      );
      // Compare against every number near the symbol: a row may state the value
      // in two units and any one of them agreeing is enough to keep it.
      // The sign is part of the number (review #399): "-2150" extracted as
      // "2150" agreed with a tree declaring 2150 and shipped the row labelled
      // [code-checked] — an opposite-signed value positively vouched for by a
      // check. `valuesAgree` parses leading [+-] itself, so the extractor must
      // not drop it. A hyphen separated by spaces stays a separator, not a
      // sign: "2150 - 300 discount" still compares 2150.
      const near = tail.match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
      let agreed = false;
      for (const n of near) {
        if (valuesAgree(n, code) === true) {
          agreed = true;
          return { verdict: "agrees", ref, claim: n };
        }
      }
      if (!agreed && near.length) {
        return { verdict: "contradicts", ref, claim: near[0] };
      }
    }
    match = SYMBOL.exec(content);
  }
  void sawResolvable;
  return { verdict: "undecidable" };
}

/**
 * The declared-ref form, kept for callers that already carry a ref (the guided
 * contradiction surface). Any uncertainty is `undecidable`, never `contradicts`.
 */
export function claimVerdict(
  repoDir: string | undefined,
  ref: string,
  claim: string,
): ClaimVerdict {
  if (!repoDir || !ref || !claim) return "undecidable";
  const fact = findConstant(repoDir, ref);
  if (!fact) return "undecidable";
  const agree = valuesAgree(claim, String(fact.value));
  if (agree === true) return "agrees";
  if (agree === false) return "contradicts";
  return "undecidable";
}
