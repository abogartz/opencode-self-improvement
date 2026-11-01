// target — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.

import { type Memory, targetScore } from "../model/memory.ts";

export type TargetResolution =
  | { status: "ok"; target: Memory }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: Memory[] };

// Pick the row an update/merge call means. Without a query the caller keeps the
// legacy "most recent active row of this scope+type" behaviour; with one, a
// miss or a tie fails CLOSED rather than silently rewriting a different row.
export function resolveMemoryTarget(rows: Memory[], query?: string): TargetResolution {
  if (!query || !query.trim()) {
    const last = rows[rows.length - 1];
    return last ? { status: "ok", target: last } : { status: "not_found" };
  }
  const q = query.trim().toLowerCase();
  let best: Memory | undefined;
  let bestScore = 0;
  const tied: Memory[] = [];
  for (const m of rows) {
    const score = targetScore(m, q);
    if (score > bestScore) {
      best = m;
      bestScore = score;
      tied.length = 0;
      tied.push(m);
    } else if (score === bestScore && score > 0) {
      tied.push(m);
    }
  }
  if (!best) return { status: "not_found" };
  if (tied.length > 1) return { status: "ambiguous", candidates: tied };
  return { status: "ok", target: best };
}
