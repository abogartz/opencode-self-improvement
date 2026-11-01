// format — split from src/status.ts (#168 domain restructure). Declaration bodies are unchanged.

import { type Measured, type StatusPayload } from "./payload.ts";

/** Human byte count, base 1024, one decimal above a kilobyte. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 102.4)) / 10} MB`;
}

/** Duration in the unit a reader actually parses: s / min / h. */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 360_000) / 10} h`;
}

// --- shared formatting (the /memory panel and memory_status render 1:1) ------

/** Char counts are exact; tokens are an estimate, chars/4, shown only with "≈". */
export function estTok(chars: number): number {
  return Math.round(chars / 4);
}

/** 9999 -> "9999"; 10000 -> "10k"; 41234 -> "41.2k". */
export function fmtCount(n: number): string {
  if (n < 10_000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/** Session-wide prompt-cache hit rate from measured usage; null = nothing measured. */
export function cacheRate(m?: Measured | null): { read: number; prompt: number; pct: number } | null {
  if (!m) return null;
  const prompt = (m.input || 0) + (m.read || 0) + (m.write || 0);
  if (prompt <= 0) return null;
  return { read: m.read || 0, prompt, pct: Math.round(((m.read || 0) / prompt) * 100) };
}

/**
 * Badge dot state: green = no invalidation since the last measured turn AND
 * last measured reads >= 90%; recent = the epoch moved after the last
 * measurement (a bust we have not yet seen re-warm); amber 50-89%; red < 50%;
 * unknown = nothing measured yet (NEVER show 0% for "no data").
 */
export type CacheHealth = "green" | "recent" | "amber" | "red" | "unknown";

export function cacheHealth(p: StatusPayload): CacheHealth {
  const inv = p.stats?.lastInvalidation?.at;
  if (inv && (!p.measured || inv > p.measured.at)) return "recent";
  const rate = cacheRate(p.measured);
  if (!rate) return "unknown";
  if (rate.pct >= 90) return "green";
  if (rate.pct >= 50) return "amber";
  return "red";
}
