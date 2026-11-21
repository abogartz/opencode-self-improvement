// The render side of an additive clash: `dedupeWindowGrouped` keeps both rows
// and reports the pair, and this names WHY the reader is seeing two rows that
// look alike. Without it the pass has silently swapped one wrong deletion for an
// unexplained duplicate, which is harder to debug than either.
//
// Shape follows `conflictLine` in ./conflicts.ts — both facts, the evidence, an
// Action — with one deliberate difference: a CONFLICT verdict is fixed by its
// class, and this one is not. The reader chooses, because the distinction that
// decided it (a second thing versus a corrected thing) is visible in the token
// sets but not in the prose.
import type { Memory } from "../store/model/memory.ts";
import { flattenMemoryText } from "../store/sanitize.ts";
import { contentTokens } from "./dedupe.ts";
import { cmpTs } from "../core/cmp-ts.ts";

/**
 * Cap on each token list. A pair that reaches the threshold while differing
 * widely would otherwise dump most of its vocabulary into the result; the cap
 * keeps the line readable and the count tells the reader what was withheld.
 */
export const MAX_MARKER_TOKENS = 6;

function list(tokens: string[]): string {
  const shown = tokens.slice(0, MAX_MARKER_TOKENS);
  const held = tokens.length - shown.length;
  return `${shown.join(", ")}${held > 0 ? ` (+${held} more)` : ""}`;
}

/**
 * Dropped tokens that share the SAME set of older source rows, so a token several
 * rows carried prints once beside all of them and a token unique to one row never
 * rides along claiming a row that never held it. The sources are per group, not
 * pooled across the family: in a three-member group the newest row can drop one
 * token from two older rows and a different token from only one of them, and a
 * single shared source list would assert the second token came from a row that
 * never had it.
 */
interface DropGroup {
  /** Member indexes (into `members`) that held these tokens and newest lacks. */
  sources: number[];
  /** Tokens those rows carried and the newest row dropped. */
  tokens: string[];
}

/**
 * Whether the newest member of a family drops tokens an older member carries.
 *
 * Containment alone cannot tell the two situations apart: "the longer row adds a
 * second case" and "the newer row corrected the older one" produce the same pair
 * of token sets, and the marker used to resolve that in one direction for both.
 * Recency does discriminate. A newer row that is wholly contained in an older
 * one removed something, and a removal is exactly what a correction looks like.
 *
 * `sets` are the CONTENT-only token sets, not `contentTokens`: this sentence
 * claims a token was dropped from text the reader is looking at, and the recall
 * renderer prints `content` but never `kw`, so a keyword-only difference would
 * assert a removal of a token that appears in neither rendered row.
 *
 * Returns null when the newest row cannot be identified — a family sharing one
 * timestamp carries no direction, and guessing would be worse than the neutral
 * instruction — or when no older row holds a content token the newest row lacks.
 */
function droppedByNewest(
  members: Memory[],
  sets: Set<string>[],
): { newest: number; groups: DropGroup[] } | null {
  let newest = 0;
  for (let i = 1; i < members.length; i++)
    if (cmpTs(members[i]!.ts, members[newest]!.ts) > 0) newest = i;
  if (
    members.some(
      (m, i) => i !== newest && cmpTs(m.ts, members[newest]!.ts) === 0,
    )
  )
    return null;
  const now = sets[newest]!;
  // First pass: which older rows held each token the newest row dropped.
  const order: string[] = [];
  const byToken = new Map<string, number[]>();
  sets.forEach((o, i) => {
    if (i === newest || o.size <= now.size) return;
    if (![...now].every((t) => o.has(t))) return;
    for (const t of o) {
      if (now.has(t)) continue;
      let srcs = byToken.get(t);
      if (!srcs) {
        srcs = [];
        byToken.set(t, srcs);
        order.push(t);
      }
      if (!srcs.includes(i)) srcs.push(i);
    }
  });
  // Second pass: collapse tokens that share a source set into one group, keeping
  // first-seen order so the sentence and the cap stay stable.
  const groups: DropGroup[] = [];
  const at = new Map<string, number>();
  for (const t of order) {
    const srcs = byToken.get(t)!;
    const key = srcs.join(",");
    let gi = at.get(key);
    if (gi === undefined) {
      gi = groups.length;
      at.set(key, gi);
      groups.push({ sources: srcs, tokens: [] });
    }
    groups[gi]!.tokens.push(t);
  }
  return groups.length ? { newest, groups } : null;
}

/**
 * One line for one additive family, naming each member by its 1-based position
 * in the returned window. A family is however many rows the pass kept together,
 * so the line count tracks the number of unexplained groups rather than the
 * number of pairs inside them: five mutually additive rows are one line, not
 * ten. The scope is store text and is flattened like every other rendered
 * field: one row is one line, so a stored newline cannot forge a section here
 * either.
 */
export function ambiguousLine(members: Memory[], positions: number[]): string {
  const sets = members.map((m) => contentTokens(m));
  // The drop claim is drawn from CONTENT only. The clash test above may use
  // keywords, but this sentence describes text the reader sees, and the recall
  // renderer prints `content` and never `kw` — a keyword-only difference would
  // assert the removal of a token that appears in neither rendered row.
  const contentSets = members.map((m) =>
    contentTokens({ ...m, kw: undefined }),
  );
  // Each side lists what THAT member has that none of the others have, so a
  // nested chain prints one side rather than one per member: every row but the
  // largest is wholly contained in the union of the rest. The line therefore
  // grows with the vocabulary of the family, not with its size.
  const sides: string[] = [];
  sets.forEach((t, i) => {
    const others = new Set<string>();
    sets.forEach((o, j) => {
      if (j !== i) for (const tok of o) others.add(tok);
    });
    const only = [...t].filter((tok) => !others.has(tok));
    if (only.length) sides.push(`only in ${positions[i]}: ${list(only)}`);
  });
  const rowsLabel = (idx: number[]): string =>
    idx.length === 1
      ? `row ${positions[idx[0]!]}`
      : `rows ${idx
          .slice(0, -1)
          .map((i) => positions[i])
          .join(", ")} and ${positions[idx[idx.length - 1]!]}`;
  const where = rowsLabel(positions.map((_, i) => i));
  const rest =
    positions.length === 2
      ? "neither restates the other"
      : "none restates the others";
  // Two readings fit the same token sets, and they need opposite instructions.
  // When the newest row is the one that left something out, saying "neither
  // supersedes the other" states as fact the one thing the text cannot
  // establish, so the line names the removal and leaves the verdict open.
  const drop = droppedByNewest(members, contentSets);
  let action: string;
  if (drop) {
    // One clause per source group, capped across the whole family. With a single
    // source this collapses to the original "row 2 drops python from row 1" (and
    // the same list(...) form for several tokens), which the reproducer pins.
    let budget = MAX_MARKER_TOKENS;
    let held = 0;
    const clauses: string[] = [];
    for (const g of drop.groups) {
      if (budget <= 0) {
        held += g.tokens.length;
        continue;
      }
      const shown = g.tokens.slice(0, budget);
      budget -= shown.length;
      held += g.tokens.length - shown.length;
      clauses.push(`${list(shown)} from ${rowsLabel(g.sources)}`);
    }
    action =
      `Action: ${rowsLabel([drop.newest])} drops ${clauses.join(" and ")}` +
      (held > 0 ? ` (+${held} more)` : "") +
      ` — that may be a correction rather than a narrower case. Verify which ` +
      `before relying on either; both stay available.`;
  } else {
    action =
      `Action: neither supersedes the other. Pick by what you are actually doing; ` +
      `if both apply, use both.`;
  }
  return (
    `AMBIGUOUS (${flattenMemoryText(members[0]!.scope)}): ${where} share ` +
    `shape but ${rest}${sides.length ? ` — ${sides.join("; ")}` : ""}. ` +
    action
  );
}
