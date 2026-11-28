// metrics — split from src/status.ts. Declaration bodies are unchanged.
import { join } from "node:path";
import { evidenceDir } from "../core/config/paths.ts";
import { parseLine } from "../core/logfmt/format.ts";
import { readLines } from "../core/logfmt/read.ts";
import { recordedHarness } from "../telemetry/harness.ts";

/**
 * True when the ledger cannot honestly cover the 30-day window: its first
 * line is younger than the window, or there is no ledger at all. Every "never
 * retrieved" surface must carry this qualifier when it returns true.
 */
export function ledgerIsYoung(
  ledgerSince: string | null | undefined,
  now = Date.now(),
): boolean {
  if (!ledgerSince) return true;
  return ledgerSince > new Date(now - 30 * 86_400_000).toISOString();
}

/** Percentile of an unsorted list, nearest-rank. Empty input has no answer. */
export function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[idx];
}

/** Rows created per day across `days`, counting only days the store saw activity. */
export function rowsPerDay(
  rows: { ts: string }[],
  days = 30,
  now = Date.now(),
): number | null {
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
export function captureLag(
  lines: string[],
  days = 30,
  now = Date.now(),
): { p50: number; p95: number; n: number } {
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
    const day = new Date(Date.now() - d * 86_400_000)
      .toISOString()
      .split("T")[0]!;
    out.push(...(await readLines(join(dir, `${day}.logfmt`))));
  }
  return out;
}

/**
 * What the plugin's own model calls cost.
 *
 * Capture is a separate `generate.text` call made after the turn, so it appears
 * in NO session's usage: read from the session event stream the plugin's cost
 * is exactly zero, which is how it was billed for its whole history. The host
 * exposes no receipt either — `ctx.generate` has one member, `text`, and it
 * resolves to `{ text }` with no `usage` and no `tokens` (probed against the
 * running host, 2026-11-11). So this is an ESTIMATE, labelled as one on every
 * line, and the honest alternative to it is silence rather than a rounder number.
 *
 * Estimate is chars/4 both ways, the same convention `estTok` uses for the
 * injected block. It cannot see reasoning tokens, which on a local seat are the
 * bulk of a capture completion (measured 94%), so it UNDERSTATES. Say so where
 * it is rendered.
 */
export interface CaptureCost {
  /** Capture model calls that completed in the window. */
  calls: number;
  /** Distinct sessions those calls belong to. */
  sessions: number;
  promptChars: number;
  textChars: number;
  /** chars/4, both directions summed. An estimate, never a receipt. */
  estTokens: number;
  /** Always "estimate": no provider receipt exists for these calls. */
  source: "estimate";
}

export function captureCost(
  lines: string[],
  days = 30,
  now = Date.now(),
): CaptureCost {
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  const out: CaptureCost = {
    calls: 0,
    sessions: 0,
    promptChars: 0,
    textChars: 0,
    estTokens: 0,
    source: "estimate",
  };
  const seen = new Set<string>();
  for (const line of lines) {
    const f = parseLine(line);
    if (!f || f.ev !== "capture_cost") continue;
    if (typeof f.ts === "string" && f.ts < cutoff) continue;
    // A blank or non-numeric count is skipped, NOT read as zero: `Number("")`
    // is 0, so a line whose count failed to render would be billed as a free
    // capture — the exact error this whole ticket exists to remove.
    const raw = f.prompt_chars;
    const chars =
      typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(chars) || chars < 0) continue;
    out.calls++;
    out.promptChars += chars;
    out.textChars += Number(f.text_chars) || 0;
    out.estTokens +=
      Number(f.est_tokens) ||
      Math.ceil((chars + (Number(f.text_chars) || 0)) / 4);
    const sid = typeof f.session === "string" ? f.session : "";
    if (sid) seen.add(`${recordedHarness(f.harness)}\0${sid}`);
  }
  out.sessions = seen.size;
  return out;
}

/**
 * Capture health: the answer to "is auto-capture off, misconfigured,
 * armed-but-inert, or alive?" read from the evidence file ALONE — the
 * `plugin_load` heartbeat names the configured state, `auto_capture_*` lines
 * name the activity. The newest heartbeat wins (a reload with new options
 * replaces the old state); activity is counted inside the trailing window.
 */
export type CaptureHealthState =
  | "unknown"
  | "off"
  | "switch_mismatch"
  | "invalid_model"
  | "no_capabilities"
  | "on";

export interface CaptureHealth {
  state: CaptureHealthState;
  /** Promoted capture rows in the window. */
  rows: number;
  /**
   * `auto_capture_scan` passes in the window that read a corpus
   * (`tracked=true`), and how many carried `capped=true`. A pass abandoned
   * before its first check logs `tracked=false` and enters neither count.
   * Optional so a window with no scan evidence makes no truncation claim
   * either way.
   */
  passes?: number;
  cappedPasses?: number;
  /** Blocked / refused / partial capture outcomes in the window. */
  blocked: number;
  /** Newest `auto_capture_*` line, or null when nothing fired. */
  lastFired: string | null;
  /**
   * Newest `capture_lag` completion receipt in the window: proof the capture
   * ran, independent of candidate outcome. A model response of `[]` writes
   * only this line, so the inert verdict must consult it ( F1).
   */
  lastExecuted: string | null;
  /**
   * Newest `auto_capture_start` receipt: a pass reached the model call. It is
   * written only after every skip decision, so a deliberate skip never sets it.
   * A start with no `capture_cost` means completion was unobserved — a different
   * fact from a deliberate skip (`auto_capture_skipped`, no start line) and from
   * a completed run (a `capture_lag` receipt).
   */
  lastStarted?: string | null;
  /**
   * Newest `auto_capture_seen` arrival receipt in the window whose
   * `discard=none`: an event reached the plugin, the dispatch loop skipped
   * nothing, and a pass owed to it should have begun. Never feeds
   * `lastFired` — seeing an event is not firing, and counting it would make
   * an arrived-but-lost turn read as alive.
   */
  lastArrived?: string | null;
  /**
   * `lastArrived` is newer than every outcome that could account for it
   * (`auto_capture_start` or `auto_capture_skipped`): the newest proceeding
   * arrival produced no pass. Attributed discards (`discard=cooldown`,
   * `discard=no_sid`) never set `lastArrived`, and a store with no arrival
   * lines claims nothing — old evidence renders exactly as before.
   */
  arrivedWithoutStart?: boolean;
  /**
   * Newest `auto_capture_dispose` flush: an armed instance was disposed with no
   * turn-end event observed and no pass started. Predictive — built for the state
   * the original report inferred, not one observed on a released host; an idle
   * instance restarted between turns produces it too.
   */
  lastMissed?: string | null;
}

const CAPTURE_STATES: readonly CaptureHealthState[] = [
  "off",
  "switch_mismatch",
  "invalid_model",
  "no_capabilities",
  "on",
];

export function captureHealth(
  lines: string[],
  days = 30,
  now = Date.now(),
): CaptureHealth {
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  let state: CaptureHealthState = "unknown";
  let newestHeartbeat = "";
  let rows = 0;
  let blocked = 0;
  let passes = 0;
  let cappedPasses = 0;
  let lastFired: string | null = null;
  let lastExecuted: string | null = null;
  let lastStarted: string | null = null;
  let lastMissed: string | null = null;
  let lastArrived: string | null = null;
  let lastSkipped = "";
  for (const line of lines) {
    const f = parseLine(line);
    if (!f) continue;
    const ev = String(f.ev ?? "");
    const ts = typeof f.ts === "string" ? f.ts : "";
    if (ev === "plugin_load") {
      // Newest wins regardless of the order files were read in. A heartbeat
      // whose capture field is missing or unrecognized names no state.
      if (ts >= newestHeartbeat) {
        newestHeartbeat = ts;
        const c = String(f.capture ?? "");
        state = (CAPTURE_STATES as readonly string[]).includes(c)
          ? (c as CaptureHealthState)
          : "unknown";
      }
      continue;
    }
    if (ev === "capture_lag") {
      // Completion receipt: the model call finished whether or not it found
      // candidates. Execution evidence on its own ( F1).
      if (ts && ts >= cutoff && (!lastExecuted || ts > lastExecuted))
        lastExecuted = ts;
      continue;
    }
    if (ev === "auto_capture_start") {
      // A pass began (the turn-end event reached the plugin). Tracked apart from
      // lastFired: a start with no completion is a cut, not a verdict, so
      // it must not make a never-completed capture look "fired and alive."
      if (ts && ts >= cutoff && (!lastStarted || ts > lastStarted))
        lastStarted = ts;
      continue;
    }
    if (ev === "auto_capture_dispose") {
      // The disposal flush: armed, disposed, never a turn-end event.
      if (ts && ts >= cutoff && (!lastMissed || ts > lastMissed))
        lastMissed = ts;
      continue;
    }
    if (ev === "auto_capture_seen") {
      // The arrival receipt, written at the dispatch head before any skip
      // can drop the event. It must be handled HERE: the generic
      // `auto_capture_` fall-through below advances `lastFired`, which would
      // read an arrived-but-lost turn as "fired and alive" — the one
      // misdiagnosis this line exists to prevent. Only `discard=none` owes a
      // pass; `cooldown` and `no_sid` carry their own attribution.
      if (
        ts &&
        ts >= cutoff &&
        String(f.discard ?? "") === "none" &&
        (!lastArrived || ts > lastArrived)
      )
        lastArrived = ts;
      continue;
    }
    if (!ev.startsWith("auto_capture_")) continue;
    if (ts && ts < cutoff) continue;
    // A deliberate skip accounts for the arrival that preceded it, so its
    // timestamp bounds `arrivedWithoutStart` below. Everything else this
    // tail does (rows, blocked, passes, `lastFired`) is unchanged.
    if (ev === "auto_capture_skipped" && ts && ts > lastSkipped)
      lastSkipped = ts;
    if (ev === "auto_capture_scan") {
      // Corpus state must ride any count this parser reports: only a pass
      // that read a corpus (`tracked=true`) enters the counts, and a
      // `capped=true` pass among them read a truncated one.
      if (String(f.tracked) === "true") passes++;
      if (String(f.capped) === "true") cappedPasses++;
    }
    if (ev.endsWith("promoted")) rows++;
    else if (
      ev.endsWith("blocked") ||
      ev.endsWith("refused") ||
      ev.endsWith("partial")
    )
      blocked++;
    if (ts && (!lastFired || ts > lastFired)) lastFired = ts;
  }
  // The newest outcome that could account for an arrival. A same-millisecond
  // start or skip counts as accounted for: this comparison withholds a
  // verdict when unsure, never invents one — the opposite bias of the
  // `lastFired` misread this whole line exists to prevent.
  const lastOutcome =
    lastStarted && lastStarted > lastSkipped ? lastStarted : lastSkipped;
  return {
    state,
    rows,
    blocked,
    passes,
    cappedPasses,
    lastFired,
    lastExecuted,
    lastStarted,
    lastMissed,
    lastArrived,
    arrivedWithoutStart: lastArrived !== null && lastArrived > lastOutcome,
  };
}
