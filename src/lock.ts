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
// One lock per store file, held across the whole read-modify-write. Appends take
// the same lock so they cannot land inside an RMW window. Two layers, sharing
// one timeout budget:
//   - a FIFO hand-off between async tasks in THIS process, so contending
//     writers take their turn instead of spinning;
//   - a lock FILE created with O_EXCL, which is atomic across processes (and
//     exclusive against our own tasks too, since the check is in the kernel).
// A killed holder is recovered by age. A writer that waits past the budget
// gives up waiting — see onTimeout.
//
// Readers take NO lock: publishers hand over the new file with a rename
// (writeAtomic in logfmt.ts), so a reader always sees a complete store, never
// the middle of a rewrite.
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { record } from "./evidence.ts";

const LOCK_SUFFIX = ".lock";
// A lock older than this belongs to a process that died holding it.
const STALE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_BACKOFF_MS = 1;
const MAX_BACKOFF_MS = 25;
// How many consecutive create-failures with a proven-absent lock file mean
// "this filesystem is not letting us create it" rather than "we are losing a
// race with a live holder". The wait is a fast, bounded spin, not a budget.
const ABSENT_THROW_STRIKES = 8;

export function lockFileFor(file: string): string {
  return file + LOCK_SUFFIX;
}

/** Waiting past the timeout, or taking over a dead holder's lock. */
export type LockEvent = "steal" | "timeout";

export interface LockOptions {
  timeoutMs?: number;
  /**
   * What waiting past `timeoutMs` means. "fail" refuses the mutation (for
   * callers where proceeding unlocked could destroy more than it saves, e.g.
   * snapshot restore). The legacy default, "proceed", runs it unlocked and
   * can lose acknowledged writes when another caller rewrites the same file.
   * Store writers must use LOCK_WRITE (or an explicit fail-closed policy).
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

// The one probe that can answer "there is no holder" without itself being a
// creation attempt: stat reports a held file happily (Windows shares metadata
// reads with the handle owner), ENOENT — uniquely — proves absence, and any
// other answer (an ACL that lets us neither create nor see, say) is no answer
// at all: it must count as neither.
type LockProbe = "present" | "absent" | "unknown";

async function probeLock(lockPath: string): Promise<LockProbe> {
  try {
    await stat(lockPath);
    return "present";
  } catch (probe) {
    return (probe as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
  }
}

async function stealIfStale(lockPath: string, now: number): Promise<boolean> {
  let age = -1;
  try {
    age = now - (await stat(lockPath)).mtimeMs;
  } catch {
    // Age undeterminable — typically the holder finished and removed the
    // file a moment before this stat. "Not stealable" is the safe answer:
    // the caller backs off within the budget and the next create wins.
    // The old "retry the create immediately" here turned a stat that keeps
    // failing into a hot spin that never consulted the budget at all.
    return false;
  }
  if (age < STALE_MS) return false;
  try {
    await unlink(lockPath);
  } catch {
    return false; // another stealer won; its create decides
  }
  return true;
}

/**
 * Cross-process half: hold the lock file while `fn` runs. `now` is a seam for
 * tests that must land the budget deadline inside a specific probe iteration;
 * production callers never pass it and the real clock is used.
 */
export async function holdFileLock<T>(
  lockPath: string,
  file: string,
  fn: () => Promise<T>,
  opts: LockOptions,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const started = now();
  let backoff = MIN_BACKOFF_MS;
  let firstErr: unknown;
  let absentStrikes = 0;
  // #107: did ANY probe see a lock file during this wait? The rethrow at the
  // deadline promises we never proceed as a stranger to the lock file — but
  // `absentStrikes > 0` only remembers the LAST probe, so a holder that
  // legitimately finished and unlinked just as the budget expired was
  // throwing away ordinary writes instead of taking the contention
  // concession it describes.
  let everSawHolder = false;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.write(token);
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      // Any creation failure means: wait for the current holder, whatever
      // label it carries (POSIX EEXIST; Windows sharing violations EPERM/
      // EACCES; or the file vanishing between this open and any later probe
      // — the holder simply finished). Policies that trusted a label or a
      // one-shot probe were tried and lost rows: throwing on non-EEXIST
      // aborted writers on mislabelled contention, and throwing on a
      // stat-probe ENOENT aborted them in the vanish race.
      // The filesystem still gets the last word: if creation keeps failing
      // while stat keeps proving NO lock file exists, there is no holder to
      // wait for — our own ability to create files is what is broken, and
      // the original error must surface instead of rotting into a timeout.
      firstErr ??= err;
      const seen = await probeLock(lockPath);
      if (seen === "absent") {
        if (++absentStrikes >= ABSENT_THROW_STRIKES) throw firstErr;
      } else {
        absentStrikes = 0;
        if (seen === "present") everSawHolder = true;
      }
      if (await stealIfStale(lockPath, now())) {
        opts.onEvent?.("steal", now() - started);
        continue;
      }
      if (now() - started >= budgetMs) {
        opts.onEvent?.("timeout", now() - started);
        if (opts.onTimeout === "fail") {
          throw new Error(
            `memory store is busy: ${basename(file)} has been locked for ${now() - started}ms — retry`,
          );
        }
        // Proceeding without the lock is the designed concession to
        // contention — but never while we have seen the lock file not even
        // once: on a filesystem where we cannot create it, writing "unlocked"
        // would just mean writing unguarded. A holder we DID see and then lost
        // is ordinary contention, and belongs to the concession (#107 —
        // `absentStrikes > 0` remembered only the last probe, not the wait).
        if (!everSawHolder) throw firstErr;
        return fn();
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
  try {
    return await fn();
  } finally {
    // Never release a lock that is no longer ours: if we ran long and someone
    // stole it, unlinking would clobber the new holder.
    try {
      if ((await Bun.file(lockPath).text()) === token) await unlink(lockPath);
    } catch {
      // already gone
    }
  }
}

/**
 * Run `fn` as the only writer of `file`, in this process and every other one.
 * Sections run flat: calling this again for the same file from inside `fn`
 * waits for its own lock.
 */
export async function withStoreLock<T>(
  file: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const lockPath = lockFileFor(file);

  let releaseTurn!: () => void;
  const myTurnEnded = new Promise<void>((res) => (releaseTurn = res));
  const queuedBehind = turns.get(file);
  turns.set(file, myTurnEnded);

  const finish = () => {
    releaseTurn();
    if (turns.get(file) === myTurnEnded) turns.delete(file);
  };

  if (queuedBehind) {
    const gained = await timed(queuedBehind, timeoutMs);
    if (!gained) {
      // Give up our place in line rather than park everyone behind us on a
      // writer that is not going to finish.
      finish();
      opts.onEvent?.("timeout", Date.now() - started);
      if (opts.onTimeout === "fail") {
        throw new Error(
          `memory store is busy: ${basename(file)} has been locked for ${Date.now() - started}ms — retry`,
        );
      }
      return fn();
    }
  }

  try {
    return await holdFileLock(lockPath, file, fn, opts, timeoutMs - (Date.now() - started));
  } finally {
    finish();
  }
}
