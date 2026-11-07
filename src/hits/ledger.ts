// The use ledger (#42). Decay, consolidation and the status surfaces all act
// on memories today with no idea whether anybody ever reads them — the store
// knows what was written and nothing about what was used. This module closes
// that loop with one append-only logfmt file.
//
// What a "use" is, deliberately narrow:
//   inject  — the rows that actually survived into an epoch block (offered to
//             the model on every request of that epoch);
//   pull    — rows appended to a grep/glob/read result by the contextual pull;
//   recall  — rows returned by a memory_recall call.
//
// What it is NOT: evidence is a different file and a different contract. This
// ledger is DATA, never injected (I3 holds), never a memory row (hits.logfmt
// is in memory.ts's RESERVED set so loadAll() cannot ingest it), and it logs no
// prompt text — only the tokens a row and the query shared, each of which
// already exists inside that row.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { HITS_FILENAME, memoryRoot } from "../core/config/paths.ts";
import { bracketList, formatLine, parseLine } from "../core/logfmt/format.ts";
import {
  appendLog,
  fileIdentity,
  writeAtomic,
} from "../core/logfmt/publish.ts";
import { readLines } from "../core/logfmt/read.ts";
import type { UseSignals } from "../recall/relevant.ts";
import { withStoreLock, LOCK_WRITE } from "../store/lock.ts";
import type { Memory } from "../store/model/memory.ts";
import type { ReadSet } from "../consolidate/propose.ts";

export type HitSource = "inject" | "pull" | "recall";

export { HITS_FILENAME };

// The ledger is a bounded ring, not a growing file: one line per (source,
// session, row-set) per THROTTLE_MS, and at MAX_HITS_BYTES the older half is
// dropped whole-line. Use data older than the window is not interesting — a
// memory unused since before the window is the finding, not the record. The
// size is sized for the hour throttle (worst case ~200 B/line × 24 h × dozens
// of row-sets covering the 30-day dead-weight window for ordinary traffic);
// when it is shorter than the window, the surfaces say so with the ledger's
// own first line rather than inflating "never" (status.ledgerSince).
const MAX_HITS_BYTES = 2_000_000;
export const THROTTLE_MS = 3_600_000;
// Per-key failure cooldown, measured from the attempt's observation time.
export const RETRY_BACKOFF_MS = 60_000;
const MAX_LOGGED_TERMS = 8;

export function hitsFile(): string {
  return join(memoryRoot(), HITS_FILENAME);
}

export interface HitEntry {
  ts: string;
  src: HitSource;
  sid: string;
  mems: string[];
  terms: string[];
  /** Turn the ride landed on, when the caller knew it. Absent, never zero. */
  turn?: number;
}

/**
 * One observable outcome for one turn (#332). Recorded only for turns that ran
 * a gate command (build/test/lint/typecheck) — the only outcomes the plugin can
 * see without guessing. A turn with no gate command has NO line, which the
 * surfaces report as "outcome unknown", not as "clean".
 */
export interface TurnOutcome {
  ts: string;
  sid: string;
  turn: number;
  outcome: "PASS" | "FAIL";
  cmd: string;
}

// --- writing --------------------------------------------------------------------

// key -> next eligible observation time. Successful writes wait an hour;
// failures wait only a minute so repeated reads do not each pay a lock timeout.
const nextAttempt = new Map<string, number>();
// Reserve identical calls only while I/O is pending. A failed attempt must
// release this reservation without starting the hour-long success throttle.
const inFlight = new Set<string>();

/** Clear completed-attempt cooldowns. Tests must await all writes first:
 * clearing reservations cannot cancel I/O or isolate a still-running writer. */
export function resetHitThrottle(): void {
  if (inFlight.size)
    throw new Error("await pending recordHits calls before resetHitThrottle");
  nextAttempt.clear();
}

async function rotateIfNeeded(): Promise<void> {
  let size: number;
  try {
    size = (await stat(hitsFile())).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (size <= MAX_HITS_BYTES) return;
  // #106: anchor the halving like every other whole-file publish (#89) - on
  // Windows the rename can be refused by a reader's handle, and the retry is
  // only safe while nothing else moved this file.
  const since = await fileIdentity(hitsFile());
  const lines = (await readFile(hitsFile(), "utf8"))
    .split("\n")
    .filter((l) => l.trim());
  await writeAtomic(
    hitsFile(),
    lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n",
    since,
  );
}

/**
 * Record one use of a set of rows. Throttled per (source, session, row-set),
 * fail-soft: the ledger is telemetry, so a write failure must never break the
 * read path that noticed it.
 *
 * `terms` are the tokens the query and these rows shared (never the query
 * itself), capped and pre-sanitised by sharedTerms() in src/inject.ts. They
 * exist so #45 can ask "if we merge these rows, do the same reads still
 * land?" — a question no use log without them can answer.
 */
export async function recordHits(
  source: HitSource,
  sid: string,
  rows: Memory[],
  terms: string[] = [],
  now = Date.now(),
  turn?: number,
): Promise<boolean> {
  if (!rows.length) return false;
  const ids = rows.map((m) => m.ts);
  const key = `${source}|${sid}|${ids.join(",")}`;
  if (inFlight.has(key)) return false;
  const eligibleAt = nextAttempt.get(key);
  if (eligibleAt !== undefined && now < eligibleAt) return false;
  const line = formatLine({
    ev: "memory_used",
    ts: new Date(now).toISOString(),
    src: source,
    sid,
    mem: bracketList(ids),
    ...(terms.length
      ? { terms: bracketList(terms.slice(0, MAX_LOGGED_TERMS)) }
      : {}),
    // #332: the turn is what lets a ride be joined to the outcome of the same
    // turn. The throttle key deliberately EXCLUDES it — a row-set that keeps
    // riding is credited once per hour, so a join sees the turn of the
    // observation that survived the throttle, not every turn it rode. Rides
    // are therefore a floor.
    ...(typeof turn === "number" ? { turn } : {}),
  });
  inFlight.add(key);
  let cooldown = RETRY_BACKOFF_MS;
  try {
    await withStoreLock(
      hitsFile(),
      async () => {
        await rotateIfNeeded();
        await appendLog(hitsFile(), line);
      },
      LOCK_WRITE,
    );
    cooldown = THROTTLE_MS;
    return true;
  } catch {
    // Fail-closed lock contention can drop this use observation. Decay and
    // consolidation therefore see a best-effort ledger, not proof of non-use;
    // retrieval remains available even when its telemetry cannot be persisted.
    return false; // telemetry never breaks retrieval
  } finally {
    nextAttempt.set(key, now + cooldown);
    // Bound both successful and failed keys with the existing eviction cap.
    if (nextAttempt.size > 2000) {
      for (const k of [...nextAttempt.keys()].slice(0, 1000))
        nextAttempt.delete(k);
    }
    inFlight.delete(key);
  }
}

// --- outcomes (#332) -------------------------------------------------------------

/**
 * Record the observable outcome of a turn that ran a gate command. Same file,
 * same lock, same rotation as the rides it will be joined against — the join
 * has to be cheap and inside one bounded window, which is why this is NOT read
 * back out of the evidence log (evidence is the audit trail and is pruned and
 * quarantined on its own schedule).
 *
 * Fail-soft for the same reason as recordHits: telemetry must never break the
 * tool path that noticed it.
 */
export async function recordOutcome(
  sid: string,
  turn: number,
  outcome: "PASS" | "FAIL",
  cmd: string,
  now = Date.now(),
): Promise<boolean> {
  if (!sid || !Number.isFinite(turn)) return false;
  const line = formatLine({
    ev: "turn_outcome",
    ts: new Date(now).toISOString(),
    sid,
    turn,
    outcome,
    cmd,
  });
  try {
    await withStoreLock(
      hitsFile(),
      async () => {
        await rotateIfNeeded();
        await appendLog(hitsFile(), line);
      },
      LOCK_WRITE,
    );
    return true;
  } catch {
    return false;
  }
}

export async function readOutcomes(): Promise<TurnOutcome[]> {
  const out: TurnOutcome[] = [];
  for (const line of await readLines(hitsFile())) {
    const f = parseLine(line);
    if (!f || f.ev !== "turn_outcome") continue;
    const turn = typeof f.turn === "string" ? Number(f.turn) : NaN;
    if (!Number.isFinite(turn)) continue;
    const outcome = f.outcome === "FAIL" ? "FAIL" : "PASS";
    out.push({
      ts: typeof f.ts === "string" ? f.ts : "",
      sid: typeof f.sid === "string" ? f.sid : "",
      turn,
      outcome,
      cmd: typeof f.cmd === "string" ? f.cmd : "",
    });
  }
  return out;
}

/**
 * What the ledger can say about one row, without claiming causation.
 *
 * `rides`      — use lines crediting the row (a floor: throttled and dropped
 *                writes are invisible).
 * `joined`     — rides that landed on a turn which ALSO recorded a gate
 *                outcome. Everything else is unmeasured, not clean.
 * `clean`      — joined rides whose turn passed its gate.
 * `failAfter`  — joined rides whose turn failed its gate.
 *
 * A FAIL on the ride's own turn is correlation only. The row may have been
 * irrelevant, correct-but-out-of-scope, or right and the failure someone
 * else's. Nothing here distinguishes those, so no caller may use this to
 * supersede a row on its own.
 */
export interface RowOutcome {
  rides: number;
  joined: number;
  clean: number;
  failAfter: number;
}

/**
 * Join rides to same-turn gate outcomes on (sid, turn). A ride with no turn
 * recorded (a line written before #332, or a caller that did not know the
 * turn) can never join, and counts toward `rides` only.
 */
export function joinUseWithOutcomes(
  rides: HitEntry[],
  outcomes: TurnOutcome[],
): Map<string, RowOutcome> {
  const byTurn = new Map<string, "PASS" | "FAIL">();
  for (const o of outcomes) {
    const k = `${o.sid}|${o.turn}`;
    // Worst outcome wins a turn: a failing gate is the signal we act on, and
    // a later pass in the same turn does not erase the fact that it failed.
    if (byTurn.get(k) !== "FAIL") byTurn.set(k, o.outcome);
  }
  const out = new Map<string, RowOutcome>();
  for (const line of rides) {
    const verdict =
      typeof line.turn === "number" && line.sid
        ? byTurn.get(`${line.sid}|${line.turn}`)
        : undefined;
    for (const row of line.mems) {
      const cur = out.get(row) ?? {
        rides: 0,
        joined: 0,
        clean: 0,
        failAfter: 0,
      };
      cur.rides++;
      if (verdict === "PASS") {
        cur.joined++;
        cur.clean++;
      } else if (verdict === "FAIL") {
        cur.joined++;
        cur.failAfter++;
      }
      out.set(row, cur);
    }
  }
  return out;
}

// --- reading --------------------------------------------------------------------

export interface UseSignal {
  count: number;
  last: string; // newest hit ts
  terms: string[];
}

export interface UseLedger {
  /** row ts -> what the ledger knows about it. */
  byRow: Map<string, UseSignal>;
  /** oldest line in the ledger — "never retrieved" is only true since this. */
  since: string | null;
  lines: number;
}

/** Read the whole ledger. Cheap by construction: it is a bounded ring. */
export async function readLedger(): Promise<UseLedger> {
  const byRow = new Map<string, UseSignal>();
  let since: string | null = null;
  let lines = 0;
  for (const line of await readLines(hitsFile())) {
    const f = parseLine(line);
    if (!f || f.ev !== "memory_used") continue;
    lines++;
    const ts = typeof f.ts === "string" ? f.ts : "";
    if (ts && (!since || ts < since)) since = ts;
    const mem = typeof f.mem === "string" ? parseList(f.mem) : [];
    const terms = typeof f.terms === "string" ? parseList(f.terms) : [];
    for (const row of mem) {
      const cur = byRow.get(row);
      if (!cur) byRow.set(row, { count: 1, last: ts, terms: [...terms] });
      else {
        cur.count++;
        if (ts > cur.last) cur.last = ts;
        for (const t of terms) if (!cur.terms.includes(t)) cur.terms.push(t);
      }
    }
  }
  return { byRow, since, lines };
}

function parseList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Every read the ledger recorded, in file order: the terms used and the rows it
 * credited. This is the corpus consolidation (#45) replays — "would this merge
 * have lost a read that actually happened?" is only answerable against real
 * reads, and a per-row aggregate has already thrown the grouping away.
 */
export async function readReads(): Promise<ReadSet[]> {
  const out: ReadSet[] = [];
  for (const line of await readLines(hitsFile())) {
    const f = parseLine(line);
    if (!f || f.ev !== "memory_used") continue;
    const rows = typeof f.mem === "string" ? parseList(f.mem) : [];
    const terms = typeof f.terms === "string" ? parseList(f.terms) : [];
    if (rows.length) out.push({ terms, rows });
  }
  return out;
}

/**
 * Every ride the ledger recorded, with the session and turn it landed on — the
 * shape #332 joins against gate outcomes. `readLedger` aggregates by row and
 * throws the grouping away, so this reads the same file for a different
 * question rather than widening `UseLedger`, which hot paths (consolidation,
 * status) carry.
 */
export async function readRides(): Promise<HitEntry[]> {
  const out: HitEntry[] = [];
  for (const line of await readLines(hitsFile())) {
    const f = parseLine(line);
    if (!f || f.ev !== "memory_used") continue;
    const mems = typeof f.mem === "string" ? parseList(f.mem) : [];
    if (!mems.length) continue;
    const turn = typeof f.turn === "string" ? Number(f.turn) : NaN;
    out.push({
      ts: typeof f.ts === "string" ? f.ts : "",
      src: f.src === "pull" || f.src === "recall" ? f.src : "inject",
      sid: typeof f.sid === "string" ? f.sid : "",
      mems,
      terms: typeof f.terms === "string" ? parseList(f.terms) : [],
      ...(Number.isFinite(turn) ? { turn } : {}),
    });
  }
  return out;
}

/** Rows the ledger has NEVER seen used, plus the honest since-qualifier. */
export function neverRetrieved(
  rows: Memory[],
  ledger: UseLedger,
  days = 30,
): Memory[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return rows.filter((m) => {
    const u = ledger.byRow.get(m.ts);
    return !u || u.last < cutoff;
  });
}

/** Active rows used at least once inside the window. */
export function usedRecently(
  rows: Memory[],
  ledger: UseLedger,
  days = 30,
): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return rows.filter((m) => {
    const u = ledger.byRow.get(m.ts);
    return !!u && u.last >= cutoff;
  }).length;
}

// --- cached view for the read path -------------------------------------------------
// A contextual pull runs on every grep/glob/read, so the ledger is read at most
// once per LEDGER_TTL_MS. Ranking may therefore lag a write by one TTL — the
// epoch only re-scores when the store changes anyway, so this never costs a
// prompt-cache bust, and reinforcement is a tie-break, not a guarantee.

const LEDGER_TTL_MS = 60_000;
let ledgerCache: { at: number; ledger: UseLedger } | null = null;

export async function useSignals(
  ttlMs = LEDGER_TTL_MS,
  now = Date.now(),
): Promise<UseSignals> {
  if (!ledgerCache || now - ledgerCache.at > ttlMs) {
    ledgerCache = { at: now, ledger: await readLedger() };
  }
  return ledgerCache.ledger.byRow;
}

/** Drop the cached ledger (tests). There is no write hook: between resets the
 * cache simply expires after `ttlMs`, so ranking can lag a new hit by up to
 * one TTL — fine for a tie-break, and it keeps a pull from re-reading the
 * ring on every grep/glob/read. */
export function resetLedgerCache(): void {
  ledgerCache = null;
}
