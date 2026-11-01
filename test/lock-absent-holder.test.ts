// The #107 pins: the deadline rethrow in src/lock.ts must mean "we have seen
// the lock file not even once", not "the last probe happened to prove
// absence". Both races are driven deterministically — a scripted clock lands
// the budget expiry inside a specific probe iteration, and a scripted `open`
// makes a holder vanish between a failed create and the probe right after it
// — so no pin here depends on winning a wall-clock race.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as realFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Captured BEFORE the mock below, so the scripted answers can delegate to the
// genuine filesystem regardless of how the module registry settles.
const real = { open: realFs.open, unlink: realFs.unlink, stat: realFs.stat };

// ONLY the exact lock paths scripted by a test are intercepted; everything
// else — including whatever the rest of the suite imports through
// node:fs/promises after this file — passes straight through.
// NOTE (from #114's review): mock.module is process-wide in Bun and never
// uninstalled, so these two pass-through wrappers ARE the suite's fs for every
// file that runs after this one; unscripted paths hit the real functions, but
// this is permanent ambient state by design.
const scriptedOpen = new Map<string, (path: string, flags: string) => Promise<unknown>>();
const scriptedStat = new Map<string, () => Promise<unknown>>();

mock.module("node:fs/promises", () => ({
  ...realFs,
  open: (path: string | URL | number, flags?: string | number, mode?: number) => {
    if (typeof path === "string") {
      const fn = scriptedOpen.get(path);
      if (fn) return fn(path, String(flags ?? ""));
    }
    return (real.open as (p: unknown, f?: unknown, m?: unknown) => Promise<unknown>)(path, flags, mode);
  },
  stat: (path: string | URL, ...rest: unknown[]) => {
    if (typeof path === "string") {
      const fn = scriptedStat.get(path);
      if (fn) return fn();
    }
    return (real.stat as (p: string | URL, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
  },
}));

const { holdFileLock, lockFileFor } = await import( "../src/store/lock.ts");

const BUDGET = 1000;

let root: string;
afterEach(() => {
  scriptedOpen.clear();
  scriptedStat.clear();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function tmp(): string {
  root = mkdtempSync(join(tmpdir(), "osi-lock107-"));
  return root;
}

/** Answers with `times[i]` on call i, clamped to the last entry. */
function stepClock(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)] as number;
}

const errno = (code: string, op: string) =>
  Object.assign(
    new Error(`${code}: ${code === "EPERM" ? "operation not permitted" : "permission denied"}, ${op}`),
    { code },
  );

describe("absent-strike deadline rethrow (#107)", () => {
  test("a holder seen earlier and lost at the deadline keeps its write", async () => {
    // The issue's consequence 2, built deterministic: iteration 1 finds the
    // holder's file (probe: present); iteration 2's create still fails
    // against it, the holder unlinks between create and probe (strike: 1),
    // and the scripted clock expires the budget in that same iteration.
    // Pre-fix, `absentStrikes > 0` threw an ordinary LOCK_WRITE away here.
    const file = join(tmp(), "vanish.logfmt");
    const lockPath = lockFileFor(file);
    writeFileSync(lockPath, "99999-live-holder"); // held by another writer
    let opens = 0;
    scriptedOpen.set(lockPath, async (p) => {
      opens++;
      let err: unknown;
      try {
        await real.open(p, "wx"); // EEXIST: the holder's file is still on disk
      } catch (e) {
        err = e;
      }
      if (opens >= 2) await real.unlink(p).catch(() => {}); // holder just finished
      throw err;
    });
    // call order: started, iter1 steal, iter1 deadline | iter2 steal, deadline, event
    const now = stepClock([0, 0, 0, BUDGET, BUDGET, BUDGET]);
    const events: string[] = [];
    let ran = false;
    const result = await holdFileLock(
      lockPath,
      file,
      async () => {
        ran = true;
        return "written";
      },
      { onEvent: (e) => events.push(e) },
      BUDGET,
      now,
    )
      .then((v) => ({ v, threw: false }))
      .catch(() => ({ v: undefined, threw: true }));
    // The concession path: timeout was audited, the write ran unlocked.
    // Pre-fix: threw the stale creation error and lost the write.
    expect(result.threw).toBe(false);
    expect(result.v).toBe("written");
    expect(ran).toBe(true);
    expect(events).toEqual(["timeout"]);
  });

  test("a blind filesystem never writes unguarded at the deadline", async () => {
    // The issue's consequence 1, end to end: creation always fails and every
    // probe answers with a NON-ENOENT label, so strikes can never leave 0 —
    // and the deadline branch, checking `absentStrikes > 0` pre-fix, took the
    // contention concession with nothing ever proven about the filesystem.
    const file = join(tmp(), "blind.logfmt");
    const lockPath = lockFileFor(file);
    writeFileSync(file, ""); // the data file exists; the lock file never will
    scriptedOpen.set(lockPath, async () => {
      throw errno("EPERM", "open");
    });
    scriptedStat.set(lockPath, async () => {
      throw errno("EACCES", "stat");
    });
    const now = stepClock([0, 0, BUDGET]); // expires in iteration 1
    let ran = false;
    let message = "";
    try {
      await holdFileLock(
        lockPath,
        file,
        async () => {
          ran = true;
        },
        {},
        BUDGET,
        now,
      );
    } catch (e) {
      message = String((e as Error).message ?? e);
    }
    expect(ran).toBe(false); // pre-fix: TRUE — the unguarded write the comment forbids
    expect(message).toMatch(/EPERM/); // pre-fix: it never threw at all
  });

  test("eight proven-absent probes still surface the creation error, clock idle", async () => {
    // Regression pin (green on both sides): probes that prove ENOENT keep the
    // strike rule in charge — it must end the wait long before a budget it
    // never consults. The scripted clock never advances past 0, so ANY
    // progress this makes is the strikes doing their job.
    const file = join(tmp(), "nowriter.logfmt");
    const lockPath = lockFileFor(file);
    scriptedOpen.set(lockPath, async () => {
      throw errno("EPERM", "open");
    });
    // stat stays REAL here: the lock file is never created, so each probe can
    // actually prove its absence — which is exactly the strike rule's input.
    const now = stepClock([0]);
    let ran = false;
    let message = "";
    try {
      await holdFileLock(
        lockPath,
        file,
        async () => {
          ran = true;
        },
        {},
        BUDGET,
        now,
      );
    } catch (e) {
      message = String((e as Error).message ?? e);
    }
    expect(ran).toBe(false);
    expect(message).toMatch(/EPERM/);
  });
});
