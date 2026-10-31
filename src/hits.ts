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
import { memoryRoot, HITS_FILENAME } from "./config.ts";
import { appendLog, bracketList, fileIdentity, formatLine, parseLine, readLines, writeAtomic } from "./logfmt.ts";
import type { UseSignals } from "./inject.ts";
import { withStoreLock, LOCK_WRITE } from "./lock.ts";
import type { Memory } from "./memory.ts";
import type { ReadSet } from "./consolidate.ts";

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
}

// --- writing --------------------------------------------------------------------

// key -> ms of the last line actually written. The epoch block rides EVERY
// request of an epoch, so without this one "offer" would be counted dozens of
// times and the dead-weight number would be fiction.
const lastWrite = new Map<string, number>();

/** Clear the throttle window (tests; also what a process restart does). */
export function resetHitThrottle(): void {
  lastWrite.clear();
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
  const lines = (await readFile(hitsFile(), "utf8")).split("\n").filter((l) => l.trim());
  await writeAtomic(hitsFile(), lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", since);
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
): Promise<boolean> {
  if (!rows.length) return false;
  const ids = rows.map((m) => m.ts);
  const key = `${source}|${sid}|${ids.join(",")}`;
  const prev = lastWrite.get(key);
  if (prev !== undefined && now - prev < THROTTLE_MS) return false;
  lastWrite.set(key, now);
  // Bound the throttle map: sessions churn, and a long-lived server must not
  // grow one entry per row-set forever. Oldest-inserted entries go first.
  if (lastWrite.size > 2000) {
    for (const k of [...lastWrite.keys()].slice(0, 1000)) lastWrite.delete(k);
  }
  const line = formatLine({
    ev: "memory_used",
    ts: new Date(now).toISOString(),
    src: source,
    sid,
    mem: bracketList(ids),
    ...(terms.length ? { terms: bracketList(terms.slice(0, MAX_LOGGED_TERMS)) } : {}),
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
    // Fail-closed lock contention can drop this use observation. Decay and
    // consolidation therefore see a best-effort ledger, not proof of non-use;
    // retrieval remains available even when its telemetry cannot be persisted.
    return false; // telemetry never breaks retrieval
  }
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

/** Rows the ledger has NEVER seen used, plus the honest since-qualifier. */
export function neverRetrieved(rows: Memory[], ledger: UseLedger, days = 30): Memory[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return rows.filter((m) => {
    const u = ledger.byRow.get(m.ts);
    return !u || u.last < cutoff;
  });
}

/** Active rows used at least once inside the window. */
export function usedRecently(rows: Memory[], ledger: UseLedger, days = 30): number {
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

export async function useSignals(ttlMs = LEDGER_TTL_MS, now = Date.now()): Promise<UseSignals> {
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
