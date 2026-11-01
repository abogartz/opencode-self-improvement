// metrics — split from src/status.ts (#168 domain restructure). Declaration bodies are unchanged.
import { join } from "node:path";
import { evidenceDir } from "../core/config/paths.ts";
import { parseLine } from "../core/logfmt/format.ts"
import { readLines } from "../core/logfmt/read.ts";

/**
 * True when the ledger cannot honestly cover the 30-day window: its first
 * line is younger than the window, or there is no ledger at all. Every "never
 * retrieved" surface must carry this qualifier when it returns true.
 */
export function ledgerIsYoung(ledgerSince: string | null | undefined, now = Date.now()): boolean {
  if (!ledgerSince) return true;
  return ledgerSince > new Date(now - 30 * 86_400_000).toISOString();
}

/** Percentile of an unsorted list, nearest-rank. Empty input has no answer. */
export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

/** Rows created per day across `days`, counting only days the store saw activity. */
export function rowsPerDay(rows: { ts: string }[], days = 30, now = Date.now()): number | null {
  if (!rows.length) return null;
  const cutoff = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const inWindow = rows.filter((m) => m.ts.slice(0, 10) >= cutoff);
  if (!inWindow.length) return null;
  const dates = new Set(inWindow.map((m) => m.ts.slice(0, 10)));
  return Math.round((inWindow.length / dates.size) * 10) / 10;
}

/**
 * Capture latency from `capture_lag` evidence lines: how stale the newest
 * message was when the capture model was asked. Lag-less lines (a session with
 * no timestamped message) are counted in `n` only through their outcome, never
 * as a zero lag.
 */
export function captureLag(lines: string[], days = 30, now = Date.now()): { p50: number; p95: number; n: number } {
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  const lags: number[] = [];
  for (const line of lines) {
    const f = parseLine(line);
    if (!f || f.ev !== "capture_lag") continue;
    if (typeof f.ts === "string" && f.ts < cutoff) continue;
    const lag = Number(f.lag);
    if (Number.isFinite(lag) && lag >= 0) lags.push(lag);
  }
  const p50 = percentile(lags, 0.5);
  const p95 = percentile(lags, 0.95);
  return { p50: p50 ?? 0, p95: p95 ?? 0, n: lags.length };
}

/** `capture_lag` lines for the trailing window, newest evidence files first. */
export async function captureLagLines(days = 30): Promise<string[]> {
  const dir = evidenceDir();
  const out: string[] = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * 86_400_000).toISOString().split("T")[0]!;
    out.push(...(await readLines(join(dir, `${day}.logfmt`))));
  }
  return out;
}
