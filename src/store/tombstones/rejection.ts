// rejection — split from src/tombstones.ts (#168 domain restructure). Declaration bodies are unchanged.
import { join } from "node:path";
import { contentHash } from "../../evidence/record.ts";
import { memoryRoot } from "../../core/config/paths.ts";
import { NEAR_FLOOR, NEAR_MIN_SHARED, type Tombstone, differsIn, sketchOf, tombstone, tombstones, valueSigOf } from "./tombstone.ts";

const REJECTED_FILENAME = "rejected.logfmt";

export type Rejection =
  | { kind: "exact"; tombstone: Tombstone }
  | { kind: "near"; tombstone: Tombstone; score: number; shared: number };

/** The dimension on which a strong sketch match is nonetheless a different fact. */
export type ValueDifference = "numeric_value" | "polarity";

/** A sketch match over the floor that was NOT treated as the rejected value. */
export interface VetoedMatch {
  tombstone: Tombstone;
  score: number;
  shared: number;
  differs: ValueDifference;
}

export interface RejectionProbe {
  rejection?: Rejection;
  /** Set only when there is no rejection AND something over the floor was
   *  declined. Nothing is enforced from it — it exists so the guard is visible
   *  in the field, where "the mechanism never over-blocks" would otherwise be a
   *  claim with no evidence either way. */
  vetoed?: VetoedMatch;
}

export function rejectedFile(): string {
  return join(memoryRoot(), REJECTED_FILENAME);
}

/**
 * Is this content refused because a human already rejected it?
 *
 * Exact hash first: it is cheap, unambiguous, and the answer a rejection owes.
 * Near-match second, over the whole tombstone set, returning the STRONGEST
 * match rather than the first — the hint names a specific prior rejection, so
 * pointing at a weak one while a better one exists would misreport why the
 * write was refused.
 *
 * A match that {@link differsIn} calls a changed value is skipped, not scored:
 * the guard runs per candidate, so the strongest NON-vetoed match still wins
 * even when a vetoed one scores higher. That case is real — "the service must not
 * enable anonymous access…" scores 0.79 against a rejection of the ENABLE
 * statement (a polarity flip, so correctly not the rejected fact) and 0.70
 * against the rejection of DISABLE, which is what it actually restates.
 */
export async function probeRejection(content: string): Promise<RejectionProbe> {
  const all = await tombstones();
  if (all.length === 0) return {};
  const ch = contentHash(content);
  const exact = all.find((t) => t.ch === ch);
  if (exact) return { rejection: { kind: "exact", tombstone: exact } };

  const sig = sketchOf(content);
  // Below the shared-token floor a near-match cannot fire at all, so short
  // content is refused only ever on an exact match.
  if (sig.length < NEAR_MIN_SHARED) return {};
  const values = valueSigOf(content);
  let best: Extract<Rejection, { kind: "near" }> | undefined;
  let vetoed: VetoedMatch | undefined;
  for (const t of all) {
    if (t.sig.length < NEAR_MIN_SHARED) continue;
    const { score, shared } = jaccardShared(sig, t.sig);
    if (shared < NEAR_MIN_SHARED || score < NEAR_FLOOR) continue;
    const differs = differsIn(values, { num: t.num ?? [], pol: t.pol ?? [] });
    if (differs) {
      if (!vetoed || score > vetoed.score) vetoed = { tombstone: t, score, shared, differs };
      continue;
    }
    if (!best || score > best.score) best = { kind: "near", tombstone: t, score, shared };
  }
  if (best) return { rejection: best };
  return vetoed ? { vetoed } : {};
}

/** The verdict without the veto telemetry — see {@link probeRejection}. */
export async function findRejection(content: string): Promise<Rejection | undefined> {
  return (await probeRejection(content)).rejection;
}

function jaccardShared(a: string[], b: string[]): { score: number; shared: number } {
  const setB = new Set(b);
  let shared = 0;
  for (const h of a) if (setB.has(h)) shared++;
  const union = a.length + b.length - shared;
  return { score: union === 0 ? 0 : shared / union, shared };
}
