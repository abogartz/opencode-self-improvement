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
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { dateStr, evidenceDir, memoryRoot } from "./config.ts";
import { parseLine, readLines } from "./logfmt.ts";
import type { Attribution } from "./attribution.ts";

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
 * True when the ledger cannot honestly cover the 30-day window: its first
 * line is younger than the window, or there is no ledger at all. Every "never
 * retrieved" surface must carry this qualifier when it returns true.
 */
export function ledgerIsYoung(ledgerSince: string | null | undefined, now = Date.now()): boolean {
  if (!ledgerSince) return true;
  return ledgerSince > new Date(now - 30 * 86_400_000).toISOString();
}

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

export function statusFile(): string {
  return join(memoryRoot(), "status.json");
}

export function statusDir(): string {
  return join(memoryRoot(), "status");
}

// Session ids are host-generated (ses_…), but sanitize anyway: this string
// becomes a file name.
function safeName(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

export function sessionStatusFile(sessionID: string): string {
  return join(statusDir(), `${safeName(sessionID)}.json`);
}

// LRU cap on per-session files: the badge only ever reads the active session,
// so old ones are kept for post-hoc inspection up to this count, then pruned
// by mtime (newest survive; a re-written session refreshes its mtime).
const SESSION_FILE_CAP = 32;

async function pruneStatusDir(): Promise<void> {
  try {
    const names = (await readdir(statusDir())).filter((n) => n.endsWith(".json"));
    if (names.length <= SESSION_FILE_CAP) return;
    const withMtime = await Promise.all(
      names.map(async (n) => {
        try {
          return { n, m: (await stat(join(statusDir(), n))).mtimeMs };
        } catch {
          return { n, m: 0 }; // vanished mid-prune or unstatable: prune first
        }
      }),
    );
    withMtime.sort((a, b) => b.m - a.m);
    for (const f of withMtime.slice(SESSION_FILE_CAP)) {
      await rm(join(statusDir(), f.n), { force: true });
    }
  } catch {
    // pruning is housekeeping; the surfaces tolerate a growing dir
  }
}

async function writeJson(path: string, p: StatusPayload): Promise<boolean> {
  try {
    await Bun.write(path, JSON.stringify(p, null, 2) + "\n");
    return true;
  } catch {
    return false; // swallow — surfaces degrade to "no data", the session does not
  }
}

// Best-effort by design: a status write must never break injection. Writes the
// per-session file (primary) AND the global latest file (fallback).
export async function writeStatus(p: StatusPayload): Promise<void> {
  await writeJson(statusFile(), p);
  if (typeof p.sessionID === "string" && p.sessionID) {
    await writeJson(sessionStatusFile(p.sessionID), p);
    await pruneStatusDir();
  }
}

async function readJson(path: string): Promise<StatusPayload | null> {
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

/**
 * Read the status for a session. With a sessionID: ONLY that session's file —
 * a missing file returns null ("mem -") rather than another session's epoch.
 * Without one: the global latest file.
 */
export async function readStatus(sessionID?: string): Promise<StatusPayload | null> {
  if (sessionID) return readJson(sessionStatusFile(sessionID));
  return readJson(statusFile());
}

// Newest-first last `limit` write_blocked evidence rows, scanning today and
// yesterday so a block just before midnight stays visible.
export async function blockedRecent(limit = 6): Promise<BlockedRow[]> {
  const today = dateStr();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0]!;
  const rows: BlockedRow[] = [];
  for (const day of [yesterday, today]) {
    for (const line of await readLines(join(evidenceDir(), `${day}.logfmt`))) {
      const f = parseLine(line);
      if (!f || f.ev !== "write_blocked") continue;
      rows.push({
        ts: String(f.ts ?? day),
        sid: String(f.sid ?? "?"),
        reason: String(f.reason ?? "?"),
      });
    }
  }
  return rows.slice(-limit).reverse();
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

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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

export function contextLines(p: StatusPayload): string[] {
  const st = p.stats ?? emptyStats();
  const pct = p.budget > 0 ? Math.round((p.blockChars / p.budget) * 100) : 0;
  return [
    `  injected now   ${p.blockChars}c ≈ ${estTok(p.blockChars)} tok · ${pct}% of ${p.budget}c budget`,
    // The budget caps the RELEVANCE BLOCK; the standing digest and the frontier
    // ride the system prompt too. Quoting only the budgeted slice would
    // understate what the request actually carries.
    ...(p.sectionChars === undefined
      ? []
      : [
          `  memory section ${p.sectionChars}c ≈ ${estTok(p.sectionChars)} tok riding the prompt` +
            ` (digest + frontier + the ${p.blockChars}c block above)`,
        ]),
    `  this epoch     ${p.reason} epoch since ${p.at} (${ago(p.at)}) · rode ${st.epochRequests} request(s)`,
    `  session        ${st.requests} request(s) · ${fmtCount(st.cumChars)}c ≈ ${fmtCount(estTok(st.cumChars))} tok rode · abstained ${st.abstained}`,
  ];
}

export function cacheLines(p: StatusPayload): string[] {
  const st = p.stats ?? emptyStats();
  const inv =
    st.invalidations === 0
      ? [
          "  cache busts    0 — memory has never rewritten a byte of your past",
          "                 conversation, so the provider can serve history from cache",
        ]
      : [
          `  cache busts    ${st.invalidations} this session · last ${
            st.lastInvalidation ? `${st.lastInvalidation.at.slice(11, 19)} (${st.lastInvalidation.reason})` : "-"
          }`,
          "                 a memory YOU saved in this session never costs one — you",
          "                 already said it (#165). A correction, a removal, or a row",
          "                 another session wrote costs exactly one, and the prefix",
          "                 re-warms on the following turn",
        ];
  const rate = cacheRate(p.measured);
  const receipts = rate
    ? [
        `  receipts       ${fmtCount(rate.read)}/${fmtCount(rate.prompt)} prompt tok served from cache (${rate.pct}%)`,
        rate.pct >= 90
          ? "                 — memory is cache-invisible: the same bytes ride every turn"
          : "                 — below ~90% something re-bills the whole history each turn",
      ]
    : [
        "  receipts       provider reports no cache usage yet — structural proof:",
        `                 the same block bytes rode ${st.epochRequests} request(s) with ${st.invalidations} busts`,
      ];
  return [
    ...inv,
    ...receipts,
    `  recomputes     ${p.recomputes} block builds since server start (all sessions)`,
  ];
}

/**
 * CONTEXT WINDOW — the "is memory bloating my context?" answer, built ONLY from
 * numbers we trust: the exact injected block (we wrote those bytes), the
 * provider's own cache receipts, and the memory-caused bust count. No estimated
 * decomposition of the system prompt or history (we cannot measure those); the
 * one honest share we can state is memory as a slice of what was actually sent.
 */
export function windowLines(p: StatusPayload): string[] {
  const memTok = estTok(p.blockChars);
  const pct = p.budget > 0 ? Math.round((p.blockChars / p.budget) * 100) : 0;
  const out: string[] = [
    `  memory slice   ${p.blockChars}c ≈ ${memTok} tok · ${pct}% of the ${p.budget}c inject budget (hard-capped by design)`,
  ];
  const m = p.measured;
  const used = m ? (m.input || 0) + (m.read || 0) + (m.write || 0) : 0;
  if (used > 0) {
    const share = Math.round((memTok / used) * 1000) / 10;
    const rate = cacheRate(m);
    out.push(`  of what you sent  ≈ ${fmtCount(used)} prompt tok · memory is ${share}% of it`);
    out.push(
      rate
        ? `  cache served     ${rate.pct}% of that prompt from cache → memory rides free after turn 1`
        : "  cache served     provider has not reported a split yet",
    );
  } else {
    out.push("  of what you sent  not measured yet — receipts appear after the first assistant turn");
  }
  const busts = p.stats?.invalidations ?? 0;
  out.push(
    `  memory busts     ${busts} this session${busts ? "" : " — memory never invalidated your cache prefix"}`,
  );
  return out;
}

/**
 * MEMORY ATTRIBUTION — which answers came from memory instead of re-reading
 * files. Every line is labeled [measured] (an observed tool-call fact) or
 * [inferred] (a coverage statement). Misses are shown alongside saves so the
 * panel reads as an audit, not marketing.
 */
export function attributionLines(p: StatusPayload): string[] {
  const a = p.attribution;
  if (!a) return ["  not computed — no memory was injected this session"];
  if (a.pathsCited === 0 && a.commandsMatched === 0 && a.readsTotal === 0) {
    return ["  the injected memory cited no file paths or commands yet — nothing to attribute"];
  }
  return [
    `  Tier A · commands   ${a.commandSaves} lookup(s) avoided [measured] · ran a remembered command with no prior file lookup`,
    `  Tier B · coverage   cited ${a.pathsCited} · re-read ${a.pathsReRead} [measured] · not opened ${a.pathsSkipped} [inferred]`,
    `  new work            ${a.readsNotCovered}/${a.readsTotal} file lookups had no memory coverage [measured]`,
  ];
}

/**
 * Plain-text rendering shared by the memory_status tool (and any other chat
 * client). Sections match the terminal /memory panel one-for-one.
 */
export function renderMemoryReport(input: {
  status: StatusPayload | null;
  store: StoreCounts;
  blocked: BlockedRow[];
  quarantined?: { ts: string; patterns: string[] }[];
}): string {
  const { status, store, blocked } = input;
  const out: string[] = ["MEMORY STATUS", ""];
  if (input.quarantined?.length) {
    out.push("QUARANTINE", `  ${input.quarantined.length} rows withheld from recall and injection; review/release in the memory viewer.`);
    for (const row of input.quarantined.slice(0, 20)) {
      out.push(`  ${row.ts}  ${row.patterns.join(", ") || "marked for review"}`);
    }
    out.push("");
  }

  if (!status) {
    out.push(
      "CONTEXT",
      "  no epoch yet — memory has not injected this session (fresh server, or no prompt scored yet)",
    );
  } else {
    out.push("CONTEXT", ...contextLines(status));
    out.push("", "CACHE — the receipts on your prompt-cache cost", ...cacheLines(status));
    out.push("", "CONTEXT WINDOW — is memory bloating your context?", ...windowLines(status));
    out.push("", "INJECTED BLOCK (verbatim)");
    if (status.block) out.push(...status.block.split("\n").map((l) => `  ${l}`));
    else
      out.push(
        "  abstained — your prompt shares no content vocabulary with any memory, so nothing was injected (by design, no noise).",
      );
    out.push("", "MEMORY ATTRIBUTION — answered from memory vs re-reading files", ...attributionLines(status));
  }

  out.push("", "RECENT BLOCKED WRITES");
  if (!blocked.length) out.push("  (none today or yesterday)");
  for (const b of blocked) {
    out.push(`  ${b.ts}  session ${b.sid}  ${b.reason}`);
  }
  out.push("  (reasons are logged via memory_evidence; the gate never deletes — it asks for a rephrase)");

  out.push(
    "",
    "STORE",
    `  ${store.active} active · ${store.superseded} superseded · ${store.open} open · ${store.scopes} scopes` +
      (store.malformed ? ` · ${store.malformed} malformed (skipped; fix the ts= field or undo)` : ""),
  );
  if (store.neverRetrieved !== undefined) {
    const used = store.active - store.neverRetrieved;
    const share = store.active ? Math.round((store.neverRetrieved / store.active) * 100) : 0;
    // A ledger younger than the window cannot honestly call anything "never"
    // — it has not been watching long enough. Say what it covers instead of
    // letting day-one readers see 100% dead weight.
    const young = ledgerIsYoung(store.ledgerSince);
    const basis = young
      ? `, ledger only covers since ${store.ledgerSince ? store.ledgerSince.slice(0, 10) : "no lines yet"}`
      : "";
    out.push(
      `  retrieved ${used} rows in the last 30d; never retrieved ${store.neverRetrieved} (${share}%)${basis} — reported, not acted on`,
    );
  }
  const sizing: string[] = [];
  if (store.bytes !== undefined) {
    sizing.push(`${fmtBytes(store.bytes)} total · ${fmtBytes(store.bytesPerRow ?? 0)} per row`);
  }
  if (store.rowsPerDay !== undefined) sizing.push(`${store.rowsPerDay} rows/day (30d)`);
  if (store.captureLag && store.captureLag.n) {
    sizing.push(`capture lag p50 ${fmtMs(store.captureLag.p50)} / p95 ${fmtMs(store.captureLag.p95)}`);
  }
  if (sizing.length) out.push(`  ${sizing.join(" · ")}`);
  out.push("", "Terminal (CLI/TUI) users: /memory opens this as a live panel; the footer shows a one-line badge.");
  return out.join("\n");
}
