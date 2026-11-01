// payload — split from src/status.ts (#168 domain restructure). Declaration bodies are unchanged.
// The status hand-off between the two surface halves. The server plugin writes
// one status file per session on every epoch recompute AND every measured
// assistant turn (src/index.ts); the terminal plugin (src/tui.tsx) and the
// memory_status tool consume them. Status files are deliberately NOT .logfmt
// memory files — loadAll() must never ingest them.
//
// Why per-session: the epoch freeze is per-session, so a single global
// last-writer-wins file let one session's badge show another session's epoch.
// `status/<sessionID>.json` is the primary read; the global `status.json`
// survives as a "latest" fallback for argument-free reads. Both are pruned /
// written best-effort: a status failure degrades surfaces, never injection.
//
// Scope of v2: same-machine reads. Against a REMOTE server the terminal panel
// sees no status files (it says so) — the RPC surface is the planned follow-up.
import { readFile } from "node:fs/promises";
import type { Attribution } from "../inject/attribution.ts";
import { captureLag, ledgerIsYoung, rowsPerDay } from "./metrics.ts";

export interface StoreCounts {
  active: number;
  superseded: number;
  open: number;
  scopes: number;
  /** Rows skipped as malformed by the most recent store read. */
  malformed: number;
  /**
   * Active rows the use ledger has never credited (or not inside the window).
   * Undefined until #42's ledger is read — an absent number, never a zero.
   */
  neverRetrieved?: number;
  /**
   * Oldest line in the use ledger, or null when it holds none. The 30-day
   * dead-weight number is only honest inside the ledger's coverage; a young
   * ledger says so instead of inflating "never" (see `ledgerIsYoung`).
   */
  ledgerSince?: string | null;
  /** Bytes of store the active rows occupy (canonical logfmt rendering). */
  bytes?: number;
  /** Per-row average of the same, the "what does a row cost" number. */
  bytesPerRow?: number;
  /** Rows created per day over the trailing window. */
  rowsPerDay?: number;
  /** Capture latency in ms, p50/p95, from `capture_lag` evidence. */
  captureLag?: { p50: number; p95: number; n: number };
}

/**
 * Per-session ledger, incremented at the session.context injection decision
 * (so counts match exactly what was injected — an aborted turn still rode the
 * bytes). Cumulative fields are session-lifetime; epochRequests resets when a
 * new epoch freezes. An invalidation = a store_changed recompute that moved a
 * live epoch (the first epoch of a session is not one).
 */
export interface SessionStats {
  requests: number; // provider requests that injected through session.context
  abstained: number; // requests where the epoch block was empty
  cumChars: number; // lifetime sum of injected block chars
  epochRequests: number; // requests the CURRENT epoch block has ridden
  invalidations: number; // store_changed recomputes this session
  lastInvalidation: { at: string; reason: string } | null;
}

export function emptyStats(): SessionStats {
  return {
    requests: 0,
    abstained: 0,
    cumChars: 0,
    epochRequests: 0,
    invalidations: 0,
    lastInvalidation: null,
  };
}

/**
 * Measured prompt-cache usage from the last usage event — `session.usage.updated`
 * (v2 hosts) or `message.updated` assistant info (older hosts) — carrying tokens
 * {input, cache.read, cache.write}. This is the SESSION-WIDE prompt cache — the
 * honest receipt for "are we busting cache", never billed as our block's own rate.
 */
export interface Measured {
  at: string;
  input: number;
  read: number;
  write: number;
}

export interface StatusPayload {
  /** ISO instant of the epoch recompute that produced this snapshot. */
  at: string;
  sessionID: string;
  reason: "first" | "store_changed";
  /** epoch recomputes since the server process started, ALL sessions. */
  recomputes: number;
  /** exact injected block ("" = abstained: no vocabulary overlap). */
  block: string;
  blockChars: number;
  /**
   * Every memory byte riding the system prompt: digest + frontier + block.
   * Optional for backward-compatible reads of status files written before the
   * distinction existed — the panel only prints it when present.
   */
  sectionChars?: number;
  budget: number;
  store: StoreCounts;
  /** optional for backward-compatible reads of pre-v2 files. */
  stats?: SessionStats;
  measured?: Measured | null;
  /** memory-vs-files attribution for the session; null/undefined = not computed. */
  attribution?: Attribution | null;
}

export interface BlockedRow {
  ts: string;
  sid: string;
  reason: string;
}

// LRU cap on per-session files: the badge only ever reads the active session,
// so old ones are kept for post-hoc inspection up to this count, then pruned
// by mtime (newest survive; a re-written session refreshes its mtime).
export const SESSION_FILE_CAP = 32;

export async function writeJson(path: string, p: StatusPayload): Promise<boolean> {
  try {
    await Bun.write(path, JSON.stringify(p, null, 2) + "\n");
    return true;
  } catch {
    return false; // swallow — surfaces degrade to "no data", the session does not
  }
}

export async function readJson(path: string): Promise<StatusPayload | null> {
  try {
    const v: unknown = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    if (!v || typeof v !== "object") return null;
    const p = v as Partial<StatusPayload>;
    if (typeof p.at !== "string" || typeof p.block !== "string") return null;
    return p as StatusPayload;
  } catch {
    return null;
  }
}
