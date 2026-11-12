// The init stamp: plugin-internal bookkeeping for /repo-init idempotency.
//
// It deliberately does NOT live in the memory store (#374). A store row is
// reachable through `memory_remember` and `memory_import`, and nothing reserved
// the `init-stamp` tag, so any session could write a `context` row naming the
// current short HEAD and make every later `memory_init` answer "Already
// initialized" for that commit — silently, with no line saying why. Moving the
// stamp to a file under the memory root that only src/init/ reads and writes
// closes that door, and it takes the row out of `memory_recall`, export and the
// viewer, where internal state was never meant to be read.
//
// A one-time migration keeps checkouts initialized by an older release from
// re-running init. Honouring "any row that looks like a stamp" is exactly the
// forgery this ticket removes, so the migration honours a legacy row only when an
// `init_complete` evidence line names its ts. Evidence is written only by the
// plugin's own record() — no tool hands a session a write path to it — so the
// pairing says a real init audited that row. A legacy row with no matching audit
// is ignored, and init re-runs: idempotent, cheap, and the safe answer to a
// provenance the plugin cannot check. A row that passes the pairing is copied to
// the file and then retired, and the head it is copied at is the head that
// evidence line names — never the head the row's own prose claims (#376 review).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryRoot } from "../core/config/paths.ts";
import { INIT_STAMP_TAG } from "../core/tags.ts";
import { preparePrivateFile, tightenDirectory } from "../core/permissions.ts";
import { parseLine } from "../core/logfmt/format.ts";
import { readLines } from "../core/logfmt/read.ts";
import { evidenceFileFor } from "../evidence/record.ts";
import { resolveRepo } from "../identity/repokey.ts";
import { loadAll } from "../store/files/load.ts";
import { markSuperseded } from "../store/files/supersede.ts";
import {
  isVisibleTo,
  readerFromSid,
  type Reader,
} from "../store/model/visibility.ts";

export interface InitStamp {
  ts: string;
  head: string;
}

/** Where the stamps live. A sibling directory of the day files, never one of them. */
export function stampDir(): string {
  return join(memoryRoot(), "init-stamps");
}

// The file name is the repository identity key: a 12-hex-char token derived from
// the normalized origin (or the normalized path when there is no origin), so it
// survives a re-clone and never aliases two checkouts that merely share a
// directory basename. Validated anyway — a component the plugin did not mint is
// not authority to write outside the stamp directory.
function stampPath(key: string): string | null {
  if (!/^[0-9a-f]{12}$/.test(key)) return null;
  return join(stampDir(), `${key}.json`);
}

/**
 * A stamp file's contents, checked against the file it came from.
 *
 * `key` must equal the file name: the name is the repository identity, so a file
 * that landed in the wrong slot (a hand-edited store, a copy from another
 * checkout) is not this repository's stamp. `scope` and `path` are descriptive
 * only — nothing here locates state from them — so they are not validated.
 */
function parseStamp(raw: string, key: string): InitStamp | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const {
    ts,
    head,
    key: fileKey,
  } = data as {
    ts?: unknown;
    head?: unknown;
    key?: unknown;
  };
  if (typeof ts !== "string" || typeof head !== "string") return null;
  if (!ts || !head) return null;
  if (fileKey !== key) return null;
  return { ts, head };
}

function readStampFile(key: string): InitStamp | null {
  const path = stampPath(key);
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Absent, unreadable, or a directory. A file that cannot be read is treated
    // like no stamp at all: init is idempotent, so re-running it is cheap, while
    // trusting a stamp the plugin cannot parse is not.
    return null;
  }
  return parseStamp(raw, key);
}

/**
 * The day files an `init_complete` line for this row could live in.
 *
 * `appendMemory` stamps the row with the millisecond it mints; `record()` writes
 * the evidence line to whatever day it is when the line lands. An init that
 * starts at 23:59:59.999 and finishes after midnight splits the pair across two
 * day files, so the row's own day is not enough — the following day has to be
 * read too, or that migration is silently lost every night around midnight
 * (#376 review).
 */
function auditDays(ts: string): string[] {
  const day = /^(\d{4}-\d{2}-\d{2})T/.exec(ts)?.[1];
  if (!day) return [];
  const next = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(next.getTime())) return [day];
  next.setUTCDate(next.getUTCDate() + 1);
  return [day, next.toISOString().slice(0, 10)];
}

/**
 * Did a real init audit this row, and at which head? The pre-#374 run wrote
 * `stamp=<row ts>` and `head=<head>` into its `init_complete` evidence line, so
 * the pairing is the provenance the row itself cannot supply. Parsed
 * field-by-field: a value that merely contains the text cannot satisfy it.
 *
 * The head comes from the EVIDENCE LINE, never from the row's prose (#376
 * review). `appendMemory` mints `ts` at millisecond resolution and `runInit`
 * mints its stamp timestamp the same way, so two concurrent writes can land on
 * the same millisecond — 42 of 480 rows did in the review's probe. Pairing on
 * `stamp === ts` alone would then let a row that names one head retire a
 * repository's idempotency at a different head, which is the forgery #374 was
 * opened to close. Returns null when no line names this ts with a usable head.
 */
async function initAuditHead(ts: string): Promise<string | null> {
  for (const day of auditDays(ts)) {
    const file = evidenceFileFor(day);
    if (!file) continue;
    let lines: string[];
    try {
      lines = await readLines(file);
    } catch {
      continue;
    }
    for (const line of lines) {
      const fields = parseLine(line);
      if (!fields) continue;
      if (fields.ev !== "init_complete" || fields.stamp !== ts) continue;
      const head = fields.head;
      if (typeof head !== "string" || !head) continue;
      return head;
    }
  }
  return null;
}

/** The pre-#374 stamp: a `context` row in this scope tagged `init-stamp`. */
async function legacyStampRow(
  scope: string,
  reader: Reader,
): Promise<InitStamp | null> {
  const mems = (await loadAll()).filter(
    (m) => !m.superseded_by && isVisibleTo(m, reader),
  );
  for (const m of mems) {
    if (m.type !== "context" || m.scope !== scope) continue;
    if (!m.tags?.some((t) => t === INIT_STAMP_TAG)) continue;
    const head = await initAuditHead(m.ts);
    if (head === null) continue;
    return { ts: m.ts, head };
  }
  return null;
}

export interface StampRead {
  stamp: InitStamp | null;
  /** The repository identity key the stamp file is (or would be) named for. */
  key: string;
  /** True when a pre-#374 store row was honoured and copied to the file. */
  migrated: boolean;
  /**
   * The migration copy could not be written (#376 review). The row was still
   * honoured, so init stays idempotent for this run, but nothing was recorded:
   * the caller must report it the way a failed stamp write is reported, or every
   * later init re-migrates and re-claims success.
   */
  stampError?: string;
  /**
   * The honoured row is still active (#376 review): its retirement was refused
   * or threw. The migration is not lost — the file answers the next read — but
   * the store keeps a row the operator should hear about.
   */
  retireError?: string;
}

/**
 * The stamp for one repository.
 *
 * `root` is the repository root init resolved. `keyHint` is the identity the
 * caller already holds (its write target), so a normal init pays no second pair
 * of git probes; with neither, identity is resolved from `root`.
 *
 * Order: the file, then one audited legacy row (honoured once, then migrated).
 * Returns `stamp: null` when neither applies.
 */
export async function readStamp(
  scope: string,
  root: string,
  keyHint?: string,
  sid?: string,
  reader: Reader = readerFromSid(sid),
): Promise<StampRead> {
  const key =
    keyHint && /^[0-9a-f]{12}$/.test(keyHint) ? keyHint : resolveRepo(root).key;
  const file = readStampFile(key);
  if (file) return { stamp: file, key, migrated: false };
  const legacy = await legacyStampRow(scope, reader);
  if (!legacy) return { stamp: null, key, migrated: false };
  const stampError = writeStampFile(key, scope, root, legacy.head, legacy.ts);
  return {
    stamp: legacy,
    key,
    migrated: true,
    ...(stampError ? { stampError } : {}),
    ...(await retireLegacyStampRow(legacy.ts)),
  };
}

/**
 * Retire the row a migration just copied (#376 review). The stamp lives in the
 * file now, so leaving the row active would keep a piece of plugin bookkeeping in
 * the store as an ordinary row; `isInjectable` already withholds the tag from
 * every model-facing read, and this takes it out of the store's active set too.
 *
 * A refusal never undoes the migration: the copy above is what makes init
 * idempotent, and the row is inert either way. The reason is returned for the
 * caller to report, in the same shape retag.ts uses for a retirement that did
 * not land — the operator hears which half failed instead of reading a clean
 * migration.
 */
async function retireLegacyStampRow(
  ts: string,
): Promise<{ retireError?: string }> {
  try {
    const retired = await markSuperseded(ts, {
      superseded_by: "init-stamp-file",
      reason: "init",
    });
    if (retired) return {};
    // Idempotence means the row was already retired out of band, or it is gone.
    // Either way the store did not take the retirement this run asked for.
    return { retireError: `${ts}: retirement did not land` };
  } catch (err) {
    return {
      retireError: `${ts}: ${
        err instanceof Error && err.message ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Record that `scope` was initialized at `head`.
 *
 * Best-effort by contract: a store on a read-only mount must not fail an init
 * whose command rows already landed, so a fault is returned for the caller to
 * report rather than thrown. The consequence of a fault is one re-run of an
 * idempotent command, never a silently skipped init.
 */
export function writeStampFile(
  key: string,
  scope: string,
  root: string,
  head: string,
  ts: string,
): string | undefined {
  const path = stampPath(key);
  if (!path) return "stamp key is not a repository identity token";
  try {
    mkdirSync(stampDir(), { recursive: true, mode: 0o700 });
    tightenDirectory(stampDir());
    preparePrivateFile(path);
    // Per-call temp name (#89): two inits on one store must never rename each
    // other's half-written temp over a stamp.
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ key, scope, path: root, head, ts })}\n`,
      {
        mode: 0o600,
      },
    );
    renameSync(tmp, path);
    return undefined;
  } catch (err) {
    return err instanceof Error && err.message ? err.message : String(err);
  }
}

/** The identity key init stamps a repository under (exported for tests). */
export function stampKey(root: string): string {
  return resolveRepo(root).key;
}
