// Serialization for the store's write paths.
//
// Daily store files are shared by every opencode session on the machine plus
// the viewer, which is a separate process. Appending is atomic on its own
// (O_APPEND, see logfmt.ts), but supersede, prune, viewer delete and snapshot
// restore each REWRITE a whole file: a writer that read before someone else
// wrote publishes a stale copy and silently drops the other's rows. Measured
// before this module existed: 40 concurrent appends against 40 supersedes left
// 40 rows on disk; four processes writing one store kept 20 of 120.
//
// Two layers, sharing one timeout budget:
//   - a FIFO hand-off between async tasks in THIS process, one queue per lock,
//     so contending writers take their turn instead of spinning;
//   - one SQLite database per lock, claimed with BEGIN IMMEDIATE and given back
//     with ROLLBACK. SQLite's lock is a kernel byte-range lock — LockFileEx on
//     Windows, fcntl F_SETLK on POSIX — so the lock lives in the kernel's
//     handle table, not in a directory entry.
//
// Why this is not a lock file (#407). The previous protocol put the state of
// the lock in the EXISTENCE of a file and released it with unlink. On Windows
// that entry's lifetime is not ours to decide: DeleteFile marks a file for
// deletion on close and the name stays in the directory until the last handle
// closes, and a third-party handle (Defender real-time protection, the search
// indexer) opened without FILE_SHARE_DELETE makes the unlink fail outright.
// Either way an entry that means "held" can outlive the holder, and every later
// writer then waits out its budget and fails while nobody holds anything —
// reproduced on macOS by refusing unlink() alone, which POSIX cannot do. The
// handle-based alternatives are closed too: Bun ignores both UV_FS_O_EXLOCK and
// UV_FS_O_TEMPORARY on Windows (measured: a second open of the same path
// succeeds), and calling kernel32 LockFileEx through bun:ffi segfaulted Bun
// 1.4.4 on the CI runner, which settles that option by itself.
//
// SQLite removes the dependency instead of retrying around it. Nothing is
// created and nothing is deleted per acquisition — WAL keeps -wal and -shm
// alive for the life of the connection — so there is no delete for Windows to
// refuse, and a killed holder is released by the kernel. Measured on the
// Windows runner with Bun 1.4.4: 6us per acquire and release against 770us for
// the lock file, a second process refused with "database is locked", and a
// SIGKILLed holder releasing immediately where the file protocol waited out its
// stale window.
//
// Readers take NO lock: publishers hand over the new file with a rename
// (writeAtomic in logfmt.ts), so a reader always sees a complete store, never
// the middle of a rewrite.
//
// Supported storage. WAL mode needs mmap'd shared memory for -shm, which SQLite
// does not support on network filesystems. A memory root on SMB, NFS or a
// OneDrive-mounted folder is therefore unsupported (#407): writes there can
// report a disk I/O error rather than serialise. That is a deliberate cut, not
// an oversight — the lock is the correctness mechanism for the whole store, so
// a silently unserialised store on a share was the worse option.
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { ensureDir } from "../core/logfmt/publish.ts";
import { record } from "../evidence/record.ts";

/**
 * The lock database for the day files (and every other real file) of one store
 * directory. It holds no rows and can be deleted whenever no session is
 * writing: it is coordination state, not data. The name never matches the
 * `*.logfmt` glob the store is scanned with, nor the `*.tmp` or `*.lock` shapes
 * older releases left behind.
 *
 * One database covers a whole directory rather than one per day file (#407:
 * accepted). An acquisition costs about 6us, so a supersede of one row and a
 * prune that sweeps the month differ by microseconds, while one database per
 * day file would mean three WAL files per day file — hundreds of stray files in
 * a long-lived store — and a writer that touches two files would hold two
 * locks at once, which is how deadlocks are born.
 */
const LOCK_DB_NAME = ".store-lock.sqlite";
const DEFAULT_TIMEOUT_MS = 5_000;
// #216: the default policy is fail-closed, the policy #196 moved every
// production writer to. A writer that omits opts must refuse at the deadline,
// not silently reintroduce the unlocked-proceed row loss the LOCK_WRITE
// contract retired. "proceed" survives only as an explicit opt-in.
const DEFAULT_ON_TIMEOUT = "fail";
const MIN_BACKOFF_MS = 1;
const MAX_BACKOFF_MS = 25;
// Reaching WAL is a once-per-process-per-lock setup step, not the hot path, so
// it gets its own bound rather than the caller's remaining budget.
const WAL_CONVERT_BUDGET_MS = 5_000;

// The one source of the timeout policy (#216): both give-up paths — the FIFO
// hand-off and the SQLite wait — resolve through here, so the fail-closed
// default cannot drift between them.
function timeoutPolicy(opts: LockOptions): "proceed" | "fail" {
  return opts.onTimeout === "proceed" ? "proceed" : DEFAULT_ON_TIMEOUT;
}

/**
 * `timeout`: waited past the budget. `reset`: a release was refused, so the
 * connection was thrown away. SQLite should never refuse a ROLLBACK, and if it
 * does, the next writer must not inherit a half-open transaction from us.
 */
export type LockEvent = "timeout" | "reset";

export interface LockOptions {
  timeoutMs?: number;
  /**
   * What waiting past `timeoutMs` means. The default, "fail", refuses the
   * mutation (#216: fail-closed is the contract every store writer keeps;
   * LOCK_WRITE and LOCK_RESTORE spell it out). "proceed" runs the write
   * unlocked and can lose acknowledged writes when another caller rewrites
   * the same file — pass it only where that concession is intended.
   */
  onTimeout?: "proceed" | "fail";
  onEvent?: (event: LockEvent, waitedMs: number) => void;
}

// Every writer of a shared store file must respect exclusion, INCLUDING
// appenders: an unlocked append inside a holder's read-modify-write window is
// overwritten by its publish. Refuse at the deadline so the caller can retry;
// never acknowledge a mutation performed outside the holder's lock (#196).
export const LOCK_WRITE: LockOptions = {
  onTimeout: "fail",
  onEvent: (event, waitedMs) => {
    void record("store_lock", { event, waited_ms: waitedMs, op: "write" });
  },
};

export const LOCK_RESTORE: LockOptions = {
  onTimeout: "fail",
  onEvent: (event, waitedMs) => {
    void record("store_lock", { event, waited_ms: waitedMs, op: "restore" });
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const busyMessage = (file: string, waitedMs: number): string =>
  `memory store is busy: ${basename(file)} has been locked for ${waitedMs}ms — retry`;

// Resolves when the task stored as this key has finished, handing the turn to
// whoever queued after it.
const turns = new Map<string, Promise<void>>();

async function timed(prev: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gained = await Promise.race([
    prev.then(() => true),
    new Promise<boolean>((res) => (timer = setTimeout(() => res(false), ms))),
  ]);
  clearTimeout(timer);
  return gained;
}

/**
 * Cached connections, least-recently-used first (Map iteration order is
 * insertion order, so a touch is a delete plus a set).
 *
 * The cache exists because opening a connection is the expensive half of an
 * acquisition, and a real process talks to one or two store directories. It must
 * not grow without bound though: each connection holds four file descriptors
 * (database, -wal, -shm, and SQLite's own), measured at 600 descriptors for 150
 * directories. A long-lived opencode process never gets near that, but a test
 * suite that makes a temp store per test does, and a CI runner with the common
 * `ulimit -n 1024` would fail with EMFILE rather than with a useful assertion.
 *
 * So: evict only connections that are NOT holding a section, oldest first, and
 * only past the cap. The hot path never pays, because the cap is far above the
 * number of directories one process uses. Closing is what checkpoints the WAL
 * and removes -wal/-shm, and that is exactly why it happens on eviction and
 * never per acquisition (#407 is about Windows refusing a delete we do not need
 * to attempt).
 */
interface Pinned {
  db: Database;
  /** Sections currently open on this connection; never evict while non-zero. */
  inUse: number;
}

const lockDbs = new Map<string, Pinned>();
const MAX_CACHED_LOCKS = 32;

function cacheLock(dbPath: string, db: Database): void {
  lockDbs.set(dbPath, { db, inUse: 0 });
  if (lockDbs.size <= MAX_CACHED_LOCKS) return;
  for (const [path, pinned] of lockDbs) {
    if (path === dbPath || pinned.inUse > 0) continue;
    dropLockDatabase(path);
    if (lockDbs.size <= MAX_CACHED_LOCKS) return;
  }
}

/**
 * Close every connection that is not holding a section.
 *
 * A cached connection is an open file, and Windows will not delete a directory
 * that contains one. Deleting a store is a supported operation — the README
 * tells a user to reset their memories that way, and every test fixture tears
 * its store down that way — so the process needs a way to say "I am done with
 * stores". A real caller stops its sessions first; the test helper
 * `removeStore` calls this before `rmSync`.
 *
 * Connections inside a section are left alone: closing one would give up a lock
 * its writer still believes it holds.
 */
export function closeAllLockDatabases(): void {
  for (const [dbPath, pinned] of [...lockDbs]) {
    if (pinned.inUse > 0) continue;
    dropLockDatabase(dbPath);
  }
}

process.on("exit", closeAllLockDatabases);

/**
 * The locks THIS CALL CHAIN already holds. Nesting a section inside one it
 * already holds joins the outer transaction instead of starting a second one on
 * the same connection, which SQLite refuses.
 *
 * It has to be an async-context set, not a Map keyed by lock. A Map is
 * process-wide, so a task that merely happens to run while an UNRELATED task
 * holds a lock reads "already held" and writes with no lock at all — measured:
 * the sibling-holder test in test/lock-narrowing.test.ts resolved instead of
 * refusing, which is silent data loss and worse than the bug this module fixes.
 * AsyncLocalStorage scopes the set to the chain that acquired it, so a nested
 * call inherits and a sibling does not. Verified on Bun 1.4.3 across deep await
 * chains, Promise.all siblings, Promise.race and unwinding.
 */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Is this error "someone else holds it, ask again"? The distinction is
 * load-bearing: contention is waited for, anything else is thrown, because
 * waiting on a broken lock wastes five seconds and then refuses a write that
 * was never going to succeed.
 *
 * Match the whole busy FAMILY, not just SQLITE_BUSY. SQLite reports extended
 * codes for the specific kinds of wait — BUSY_RECOVERY when another connection
 * is recovering the write-ahead log after a crash, BUSY_SNAPSHOT when a read
 * transaction has to restart, BUSY_TIMEOUT — and Bun puts the EXTENDED number
 * on `errno` (261, not 5) with the extended NAME on `code`. Comparing against
 * plain SQLITE_BUSY therefore made the one situation this lock is supposed to
 * survive — a holder that died and left the WAL to be recovered — fatal: the
 * first writer after a crash got "store lock unavailable: database is locked"
 * instead of waiting the few hundred microseconds recovery takes. Measured on
 * test/scenarios-consistency.test.ts, which kills racers mid-write.
 *
 * SQLITE_BUSY is 5 and every extension is 5 | (kind << 8), so the low byte is
 * the class.
 */
function contention(err: unknown): boolean {
  const e = err as { code?: string; errno?: number } | null;
  if (typeof e?.code === "string") {
    return e.code === "SQLITE_BUSY" || e.code.startsWith("SQLITE_BUSY_");
  }
  return typeof e?.errno === "number" && (e.errno & 0xff) === 5;
}

/**
 * The class that means "the file this connection holds is gone or was replaced
 * underneath us", rather than "the disk is refusing writes".
 *
 * SQLite detects the case exactly: SQLITE_IOERR_VNODE is reported when the inode
 * behind an open handle changes. It is reachable without a defect — the store
 * directory is not ours to protect. A user can wipe and rebuild a memory root
 * while a session is alive, and test/hits.test.ts does it on purpose. The right
 * answer is to throw the stale connection away and open a fresh one, which is
 * what a handle against a replaced file needs; the wrong answer is to wait, and
 * the other wrong answer is to keep the poisoned connection and fail every later
 * write in the store.
 *
 * Repair is attempted ONCE per acquisition. A disk that genuinely cannot do I/O
 * fails the second time and the error surfaces, so this never turns a real
 * storage failure into a loop.
 */
function staleHandle(err: unknown): boolean {
  const e = err as { code?: string; errno?: number } | null;
  if (typeof e?.code === "string") return e.code.startsWith("SQLITE_IOERR");
  // SQLITE_IOERR is 10 and its extensions keep the class in the low byte.
  return typeof e?.errno === "number" && (e.errno & 0xff) === 10;
}

/**
 * The classifier above, exposed for its pin in test/lock.test.ts.
 *
 * Getting this one line wrong is what made a crashed holder fatal, and the
 * integration test for it is probabilistic: whether a second opener arrives
 * while recovery is still running depends on scheduling. The classification
 * itself is not probabilistic, so it gets a table.
 */
export const isLockContention = contention;
/** Test seam for the stale-handle classification in test/lock.test.ts. */
export const isStaleLockHandle = staleHandle;

/**
 * The store's privacy contract is owner-only files (README: new files 0600).
 * SQLite creates its own with the process umask, so all three are tightened.
 * -wal and -shm appear on first use, so this runs again after each acquisition.
 * A refused chmod is not worth failing a write over: it is the same concession
 * the README already makes for a root that reports EPERM.
 */
async function harden(dbPath: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await chmod(dbPath + suffix, 0o600).catch(() => undefined);
  }
}

async function lockDatabase(dbPath: string): Promise<Database> {
  const cached = lockDbs.get(dbPath);
  if (cached) {
    // Touch: this directory is in use, so it moves to the protected end of the
    // eviction order.
    lockDbs.delete(dbPath);
    lockDbs.set(dbPath, cached);
    return cached.db;
  }
  await ensureDir(dirname(dbPath));
  let db: Database;
  try {
    db = new Database(dbPath);
  } catch (err) {
    // SQLite flattens a refused open to "unable to open database file" and
    // drops the errno, so a store the user cannot write to — an ACL denial on
    // Windows, a read-only mount, a full disk — would report a mystery instead
    // of a cause. Name the file and the code; this is not contention, so it
    // must surface at once rather than decay into the wait below.
    const info = err as { code?: string };
    throw new Error(
      `[${info.code ?? "SQLITE_CANTOPEN"}] store lock cannot open ${dbPath}: ${(err as Error).message}`,
    );
  }
  try {
    // Before anything that can be refused: SQLite's own wait sleeps inside C
    // and would park the host's event loop for up to busy_timeout. The wait
    // policy stays ours — async, bounded, and sharing one budget with the FIFO
    // hand-off above.
    db.run("PRAGMA busy_timeout = 0");
    await ensureWal(db, dbPath);
  } catch (err) {
    db.close();
    throw err;
  }
  cacheLock(dbPath, db);
  await harden(dbPath);
  return db;
}
const journalMode = (db: Database): string =>
  String(
    (db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null)
      ?.journal_mode ?? "",
  ).toLowerCase();

/**
 * Get this connection into WAL mode, and refuse the store if we cannot.
 *
 * Converting a database to WAL takes the exclusive lock for a moment, and the
 * first statements a new connection runs against a WAL database initialise its
 * -shm index, so the FIRST open of a store races: every process that opens it
 * at the same instant can be refused with SQLITE_BUSY. Assuming a metadata read
 * is lock-free is exactly the "this one cannot need the lock" reasoning that
 * produced the bug this module is fixing — measured, both the read and the
 * conversion need the retry, and without it concurrent writers died in setup.
 *
 * A store that cannot do WAL fails here rather than running in rollback-journal
 * mode, where every acquisition creates and then DELETES a journal file — the
 * exact Windows behaviour this module exists to avoid (#407). Saying so beats
 * paying the old defect with a new layer on top.
 */
async function ensureWal(db: Database, dbPath: string): Promise<void> {
  let backoff = MIN_BACKOFF_MS;
  let waited = 0;
  for (;;) {
    const step = Date.now();
    try {
      if (journalMode(db) === "wal") return;
      db.run("PRAGMA journal_mode = WAL");
      if (journalMode(db) === "wal") return;
    } catch (err) {
      if (!contention(err)) {
        const info = err as { code?: string; errno?: number };
        throw new Error(
          `[code=${info.code ?? "-"} errno=${info.errno ?? "-"}] store lock cannot enter WAL mode for ${dbPath}: ${(err as Error).message}`,
        );
      }
    }
    await sleep(backoff);
    waited += Date.now() - step;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    if (waited >= WAL_CONVERT_BUDGET_MS) {
      throw new Error(
        `store lock could not reach WAL journal mode for ${dbPath} after ${waited}ms — another process is holding the lock database in a state that refuses it`,
      );
    }
  }
}

/**
 * Drop the connection for a lock. Used when a release fails: a connection that
 * refused ROLLBACK may still hold SQLite's write lock, and the next writer must
 * get a fresh one rather than inherit our transaction.
 */
function dropLockDatabase(dbPath: string): void {
  const pinned = lockDbs.get(dbPath);
  if (!pinned) return;
  lockDbs.delete(dbPath);
  try {
    pinned.db.close();
  } catch {
    // Already gone. A leaked handle is strictly better than a stuck one.
  }
}

/**
 * Cross-process half: hold the lock while `fn` runs. `now` is a seam for tests
 * that must land the deadline inside a specific wait iteration; production
 * callers never pass it and the real clock is used.
 */
async function holdLock<T>(
  dbPath: string,
  file: string,
  fn: () => Promise<T>,
  opts: LockOptions,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<T> {
  let db = await lockDatabase(dbPath);
  const started = now();
  let backoff = MIN_BACKOFF_MS;
  let reconnected = false;
  for (;;) {
    try {
      db.run("BEGIN IMMEDIATE");
      break;
    } catch (err) {
      if (!contention(err)) {
        if (staleHandle(err) && !reconnected) {
          // The store directory was rebuilt under this handle. Repair once and
          // try again on a fresh connection; a second failure surfaces.
          reconnected = true;
          dropLockDatabase(dbPath);
          db = await lockDatabase(dbPath);
          continue;
        }
        const info = err as { code?: string; errno?: number };
        throw new Error(
          `[code=${info.code ?? "-"} errno=${info.errno ?? "-"}] store lock unavailable for ${basename(file)}: ${(err as Error).message}`,
        );
      }
      if (now() - started >= budgetMs) {
        opts.onEvent?.("timeout", now() - started);
        if (timeoutPolicy(opts) === "fail") {
          throw new Error(busyMessage(file, now() - started));
        }
        // Proceeding without the lock is the explicit "proceed" opt-in
        // (#216: no longer the default). heldLocks is deliberately NOT touched
        // here: a writer that never held the lock must not let a nested call
        // believe it did.
        return await fn();
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
  await harden(dbPath);
  acquiredHook?.(file);
  // Protected from eviction for as long as the section runs: closing a
  // connection here would hand the next writer a different transaction and
  // silently drop the exclusion this section exists to provide.
  const pinned = lockDbs.get(dbPath);
  if (pinned) pinned.inUse++;
  const parent = heldLocks.getStore();
  const held = new Set(parent ?? []);
  held.add(dbPath);
  try {
    return await heldLocks.run(held, fn);
  } finally {
    if (pinned) pinned.inUse--;
    try {
      db.run("ROLLBACK");
    } catch (err) {
      dropLockDatabase(dbPath);
      opts.onEvent?.("reset", now() - started);
      void err;
    }
  }
}

/**
 * The shared shape of both public entry points: wait our turn in this process,
 * then take the cross-process lock, on one budget.
 */
async function acquire<T>(
  dbPath: string,
  file: string,
  fn: () => Promise<T>,
  opts: LockOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  if (busyInjector?.(file)) {
    // Reported exactly as a waited-out budget would report it, so a test that
    // injects a refusal exercises the same policy and message as a real one.
    opts.onEvent?.("timeout", 0);
    if (timeoutPolicy(opts) === "fail") {
      throw new Error(busyMessage(file, 0));
    }
    return fn();
  }

  if (heldLocks.getStore()?.has(dbPath)) {
    // Same call chain, same lock: the outer section already excludes everyone
    // else, so re-entering neither starts a second transaction nor queues
    // behind the FIFO the outer section owns. The hook still fires — it counts
    // which store files a write path touches (#215), and this path touched one.
    acquiredHook?.(file);
    return await fn();
  }

  let releaseTurn!: () => void;
  const myTurnEnded = new Promise<void>((res) => (releaseTurn = res));
  const queuedBehind = turns.get(dbPath);
  turns.set(dbPath, myTurnEnded);

  const finish = () => {
    releaseTurn();
    if (turns.get(dbPath) === myTurnEnded) turns.delete(dbPath);
  };

  if (queuedBehind) {
    const gained = await timed(queuedBehind, timeoutMs);
    if (!gained) {
      // Give up our place in line rather than park everyone behind us on a
      // writer that is not going to finish.
      finish();
      opts.onEvent?.("timeout", Date.now() - started);
      if (timeoutPolicy(opts) === "fail") {
        throw new Error(busyMessage(file, Date.now() - started));
      }
      return fn();
    }
  }

  try {
    return await holdLock(
      dbPath,
      file,
      fn,
      opts,
      timeoutMs - (Date.now() - started),
    );
  } finally {
    finish();
  }
}

/**
 * Test seam (#197): refuse the acquisition of chosen files.
 *
 * The tests that pin "a batch that published file 1 and then lost file 2 must
 * report file 1 as durable" need a refusal at a chosen point in a sequence.
 * Under the lock file a test could hold one day file and let the batch reach
 * the next one. With one lock per store directory (#407) holding any file holds
 * them all, so that driver no longer exists.
 *
 * The refusal is injected where a real one surfaces — the acquisition of the
 * named file, through the same timeout policy and the same busy message a
 * cross-process holder produces — so the reporting path under test is the real
 * one. Real cross-process refusal is pinned separately in lock.test.ts and
 * lock-write-timeout.test.ts, which is what keeps this seam honest.
 *
 * Production never installs an injector and pays one undefined check.
 */
let busyInjector: ((file: string) => boolean) | undefined;

export function setLockBusyInjector(
  injector?: (file: string) => boolean,
): void {
  busyInjector = injector;
}

/**
 * Run `fn` as the only writer of `file`, in this process and every other one.
 *
 * The lock covers the directory that holds `file`, so two writers of different
 * day files in the same store take turns. A call nested inside a section this
 * chain already holds joins it.
 */
export async function withStoreLock<T>(
  file: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  return acquire(join(dirname(file), LOCK_DB_NAME), file, fn, opts);
}

/**
 * Run `fn` under a lock of its own, named for a batch operation, WITHOUT
 * excluding the store's day-file writers.
 *
 * This exists because memory_update and memory_merge_review serialize a whole
 * read-gate-supersede sequence, and the inner steps take the day-file lock
 * themselves. Their modules state the contract: the outer lock is "a DISTINCT
 * file from anything runWriteGate or markSuperseded take (sections run flat)".
 * Folding the batch into the directory lock would hold the store-wide
 * transaction for the entire gate and make every other session wait it out, so
 * the batch keeps its own database. The acquisition order stays batch-then-file,
 * never the reverse, which is what keeps the two from deadlocking.
 */
export async function withStoreBatch<T>(
  root: string,
  name: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  return acquire(join(root, `.store-lock.${name}.sqlite`), name, fn, opts);
}

/**
 * Test seam (#215): observe how many store files a write path locks.
 *
 * The narrowing this ticket asked for is invisible to a functional test — a
 * supersede that sweeps every day file and one that touches a single file both
 * leave the same store behind — so the assertion has to be about lock
 * acquisitions. Production never installs a hook and pays one undefined check
 * per acquisition; a test sets one, reads the counts, and clears it.
 */
let acquiredHook: ((file: string) => void) | undefined;

export function setLockAcquiredHook(hook?: (file: string) => void): void {
  acquiredHook = hook;
}

/** The lock database path for a store file. For diagnostics and tests. */
export function lockDatabaseFor(file: string): string {
  return join(dirname(file), LOCK_DB_NAME);
}

/**
 * Test seam: the lock databases this process holds a handle to right now.
 *
 * The handle is the Windows-visible part of this design. Windows will not
 * delete a directory containing an open file, so a connection kept after the
 * last writer finishes turns "delete your store to reset it" into EBUSY, and
 * the test suite's temp directories into failures. That cannot be observed
 * portably by trying to delete the file — POSIX allows it either way — so the
 * seam reports the handle set directly.
 */
export function heldLockDatabases(): string[] {
  return [...lockDbs.keys()];
}
