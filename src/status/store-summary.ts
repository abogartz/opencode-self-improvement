// Shared store counts for epoch payloads and the chat report (#168).
// Callers own I/O and visibility policy; this summarizes exactly their rows.
import {
  joinUseWithOutcomes,
  neverRetrieved,
  type HitEntry,
  type TurnOutcome,
  type UseLedger,
} from "../hits/ledger.ts";
import type { Memory } from "../store/model/memory.ts";
import { isActive } from "../store/model/predicates.ts";
import type { StoreCounts } from "./payload.ts";

/**
 * A row is an eviction CANDIDATE at this many rides with no clean turn. Five,
 * not two: `recordHits` throttles a row-set to one line per hour, so rides
 * accumulate slowly and a low bar would flag a row that simply rode a bad
 * afternoon.
 */
export const EVICT_MIN_RIDES = 5;

export function summarizeStore(
  rows: Memory[],
  ledger: UseLedger,
  malformed: number,
  /**
   * Rides and gate outcomes for the join (#332). Omitted, the outcome block is
   * absent rather than zero — the caller did not look, which is a different
   * statement from "nothing helped".
   */
  use?: { rides: HitEntry[]; outcomes: TurnOutcome[] },
): { active: Memory[]; counts: StoreCounts } {
  const active = rows.filter(isActive);
  const counts: StoreCounts = {
    active: active.length,
    superseded: rows.length - active.length,
    open: active.filter((m) => m.status === "open").length,
    scopes: new Set(active.map((m) => m.scope)).size,
    malformed,
    neverRetrieved: neverRetrieved(active, ledger).length,
    ledgerSince: ledger.since,
  };
  if (use) {
    const live = new Set(active.map((m) => m.ts));
    const joined = joinUseWithOutcomes(use.rides, use.outcomes);
    let rowsMeasured = 0;
    let sumJoined = 0;
    let clean = 0;
    let failAfter = 0;
    let evictCandidates = 0;
    for (const [row, o] of joined) {
      if (!live.has(row) || o.joined === 0) continue;
      rowsMeasured++;
      sumJoined += o.joined;
      clean += o.clean;
      failAfter += o.failAfter;
      if (o.rides >= EVICT_MIN_RIDES && o.clean === 0) evictCandidates++;
    }
    counts.useOutcome = {
      rowsMeasured,
      joined: sumJoined,
      clean,
      failAfter,
      evictCandidates,
    };
  }
  return { active, counts };
}
