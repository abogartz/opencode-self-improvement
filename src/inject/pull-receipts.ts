import type { ObservedToolResult } from "../host/lifecycle.ts";
// Pull receipts track complete memory rows in a tool result observed by
// this plugin’s session.context hook. Later request transformations are opaque.
import type { Memory } from "../store/model/memory.ts";
import type { EvidenceContext } from "../telemetry/record.ts";

export interface HeldPull {
  sid: string;
  callID: string;
  header: string;
  evidence: EvidenceContext;
  tool: string;
  rows: Memory[];
  /** formatMemory(row) for each row, in the same order, as it was placed. */
  lines: string[];
  /** The query the pull searched; never logged, only reduced to shared terms. */
  query: string;
  /** Placement time for expiry and the existing per-row-set throttle. */
  at: number;
  /** Placement turn, read when the block was placed, not when it is credited. */
  turn?: number;
  turnKey?: string;
}

export interface PullCredit {
  held: HeldPull;
  /** The held rows whose lines survived into the request, in placed order. */
  rows: Memory[];
}

export interface PullLoss {
  held: HeldPull;
  /** How many of the held rows got no credit. */
  rows: number;
  /**
   * trimmed — the call's tool-result reached the request without these lines.
   * expired — no request carried the call's tool-result within the TTL.
   * evicted — pushed out by the retention cap before any request carried it.
   */
  reason: "trimmed" | "expired" | "evicted" | "replaced";
}

/** Upper bound on one instance's held placements, across all sessions. */
export const MAX_HELD_PULLS = 256;
/**
 * How long a placement waits for a request. The next request follows the
 * step's last tool result, so a placement this old belongs to a session that
 * ended, compacted the call away or never asked again; crediting it later
 * would be stale.
 */
export const HELD_PULL_TTL_MS = 30 * 60_000;

// Each copy must independently prove its rows. Replayed copies cannot combine
// their line counts to identify otherwise ambiguous rows.
function observedRows(
  results: readonly ObservedToolResult[],
  pending: Map<string, HeldPull>,
): Map<HeldPull, Set<Memory>> {
  const observed = new Map<HeldPull, Set<Memory>>();
  for (const result of results) {
    const entry = pending.get(result.callID);
    if (!entry || entry.tool !== result.tool) continue;
    const rows = survivingRows(entry, result.text);
    if (!rows) continue;
    const kept = observed.get(entry) ?? new Set<Memory>();
    for (const row of rows) kept.add(row);
    observed.set(entry, kept);
  }
  return observed;
}

// The placement header distinguishes this block from quoted output and earlier calls.
function survivingRows(entry: HeldPull, text: string): Memory[] | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(entry.header);
  if (start < 0) return undefined;
  const required = new Map<string, number>();
  for (const line of entry.lines)
    required.set(line, (required.get(line) ?? 0) + 1);
  const visible = new Map<string, number>();
  let inBlock: Map<string, number> | undefined = new Map();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === entry.header) {
      inBlock = new Map();
      continue;
    }
    if (!inBlock) continue;
    // Only the run of placed rows directly after this header is evidence.
    // A formatter's footer can echo a row after that run has ended.
    if (!required.has(line)) {
      inBlock = undefined;
      continue;
    }
    const count = (inBlock.get(line) ?? 0) + 1;
    inBlock.set(line, count);
    // A formatter can repeat a clipped block inside a single tool result.
    // Keep the highest count in one block; separate copies cannot prove twins.
    if (count > (visible.get(line) ?? 0)) visible.set(line, count);
  }
  return entry.rows.filter((_, i) => {
    const line = entry.lines[i]!;
    return (visible.get(line) ?? 0) >= required.get(line)!;
  });
}

export interface PullReceipts {
  /**
   * Hold one placement until a request shows it. Returns the placements the
   * cap pushed out, for the caller to report.
   */
  hold(entry: HeldPull): PullLoss[];
  /**
   * Settle the placements one request can answer. `sid` and `messages` come
   * from one session.context event. A matching placement header settles the
   * entry before any await. A missing header leaves the placement pending.
   */
  settle(
    sid: string | undefined,
    messages: readonly ObservedToolResult[],
    now?: number,
  ): { credits: PullCredit[]; losses: PullLoss[] };
  /** Placements still waiting for a request. */
  size(): number;
}

/**
 * One receipt book per plugin instance: two instances in one process each
 * hold their own placements, so neither can settle or replace the other's.
 */
export function createPullReceipts({
  max = MAX_HELD_PULLS,
  ttlMs = HELD_PULL_TTL_MS,
}: {
  max?: number;
  ttlMs?: number;
} = {}): PullReceipts {
  // Insertion-ordered: the first entry is always the oldest placement.
  const held = new Map<string, HeldPull>();
  const keyOf = (sid: string, callID: string) => `${sid}\u0000${callID}`;

  return {
    hold(entry) {
      const key = keyOf(entry.sid, entry.callID);
      // A repeated call ID replaces the earlier placement; the newest result
      // is the one the host will send.
      const lost: PullLoss[] = [];
      const previous = held.get(key);
      if (previous) {
        held.delete(key);
        lost.push({
          held: previous,
          rows: previous.rows.length,
          reason: "replaced",
        });
      }
      held.set(key, entry);
      for (const [oldest, value] of held) {
        if (held.size <= max) break;
        held.delete(oldest);
        lost.push({ held: value, rows: value.rows.length, reason: "evicted" });
      }
      return lost;
    },

    settle(sid, messages, now = Date.now()) {
      const credits: PullCredit[] = [];
      const losses: PullLoss[] = [];
      for (const [key, entry] of held) {
        if (now - entry.at <= ttlMs) continue;
        held.delete(key);
        losses.push({
          held: entry,
          rows: entry.rows.length,
          reason: "expired",
        });
      }
      if (typeof sid !== "string" || held.size === 0)
        return { credits, losses };
      const pending = new Map<string, HeldPull>();
      for (const entry of held.values()) {
        if (entry.sid === sid) pending.set(entry.callID, entry);
      }
      if (!pending.size) return { credits, losses };
      for (const [entry, visible] of observedRows(messages, pending)) {
        held.delete(keyOf(entry.sid, entry.callID));
        const rows = entry.rows.filter((row) => visible.has(row));
        if (rows.length) credits.push({ held: entry, rows });
        if (rows.length < entry.rows.length)
          losses.push({
            held: entry,
            rows: entry.rows.length - rows.length,
            reason: "trimmed",
          });
      }
      return { credits, losses };
    },

    size: () => held.size,
  };
}
