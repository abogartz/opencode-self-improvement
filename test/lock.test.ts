// The lock contract: one writer per store across processes and across async
// tasks inside one process; a dead holder is released by the kernel rather than
// by age; waiting past the timeout fails closed by default and proceeds only by
// explicit opt-in (#216); and the lock itself is never created or deleted per
// acquisition, which is the property the lock file could not keep on Windows
// (#407).
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendLog } from "../src/core/logfmt/publish.ts";
import {
  closeAllLockDatabases,
  heldLockDatabases,
  isLockContention,
  lockDatabaseFor,
  setLockAcquiredHook,
  withStoreLock,
} from "../src/store/lock.ts";
import { childHolder } from "./helpers/hold-cross-process.ts";
import { lockArtifacts, lockIdentity } from "./helpers/lock-identity.ts";
import { sleep } from "./helpers/logfmt.ts";
import { removeStore } from "./helpers/remove-store.ts";

const roots: string[] = [];
function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), "osi-lock-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  // Every connection is closed before its directory goes away. A live handle
  // under a removed store is not fatal on macOS, but it is on Windows, and the
  // suite must fail the same way on both.
  closeAllLockDatabases();
  for (const r of roots.splice(0)) {
    removeStore(r);
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await sleep(5);
  }
}

describe("withStoreLock", () => {
  test("sections never overlap, even when they are concurrent tasks", async () => {
    const file = join(tmp(), "a.logfmt");
    let inside = 0;
    let maxInside = 0;
    const section = () =>
      withStoreLock(file, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await sleep(3);
        inside--;
      });
    await Promise.all([section(), section(), section(), section(), section()]);
    expect(maxInside).toBe(1);
    expect(inside).toBe(0);
  });

  test("a failing section releases the lock", async () => {
    const file = join(tmp(), "a.logfmt");
    await expect(
      withStoreLock(file, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const started = Date.now();
    expect(await withStoreLock(file, async () => "next")).toBe("next");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("stores in different directories are not contended", async () => {
    // The lock is per store DIRECTORY, so independence now means a different
    // directory. Two day files inside one store ARE contended on purpose, and
    // the test below pins that.
    const [a, b] = [join(tmp(), "a.logfmt"), join(tmp(), "b.logfmt")];
    const gate = deferred();
    let bFinished = false;
    const holding = withStoreLock(a, () => gate.promise);
    const other = withStoreLock(b, async () => {
      bFinished = true;
    });
    await other;
    expect(bFinished).toBe(true); // never waited on a's lock
    gate.resolve();
    await holding;
  });

  test("two day files in one store take turns, by design", async () => {
    // #407 accepted this coarsening: one kernel lock per store instead of one
    // per day file, because an acquisition costs microseconds and a lock per
    // day file would mean three WAL files per day file plus a writer holding
    // two locks at once. What must NOT happen is both writing at the same time.
    const root = tmp();
    const [a, b] = [join(root, "a.logfmt"), join(root, "b.logfmt")];
    let inside = 0;
    let maxInside = 0;
    const section = (file: string) =>
      withStoreLock(file, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await sleep(3);
        inside--;
      });
    await Promise.all([section(a), section(b), section(a), section(b)]);
    expect(maxInside).toBe(1);
  });

  test("a holder killed with SIGKILL releases the lock at once", async () => {
    // This replaces the age-based takeover the lock file needed. There is no
    // stale window to wait out and nothing to steal: the kernel drops the lock
    // when the holder's handles close, so the next writer gets it immediately.
    const file = join(tmp(), "a.logfmt");
    const holder = await childHolder(file);
    holder.crash();
    await holder.proc.exited;
    const started = Date.now();
    const outcome = await withStoreLock(file, async () => "ran", {
      timeoutMs: 2000,
    });
    expect(outcome).toBe("ran");
    // Generous ceiling for a loaded runner; the point is it does not wait out a
    // stale-age window, which was 10s.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a fresh holder is not stale: waiting past the timeout fails closed", async () => {
    const file = join(tmp(), "a.logfmt");
    const gate = deferred();
    const held = withStoreLock(file, () => gate.promise);
    await until(() => existsSync(lockDatabaseFor(file)));
    const events: string[] = [];
    await expect(
      withStoreLock(file, async () => "nope", {
        timeoutMs: 60,
        onTimeout: "fail",
        onEvent: (e) => events.push(e),
      }),
    ).rejects.toThrow(/busy/);
    expect(events).toEqual(["timeout"]);
    gate.resolve();
    await held;
  });

  test("an explicit proceed opt-in runs the write unlocked and reports it", async () => {
    const file = join(tmp(), "a.logfmt");
    const gate = deferred();
    const held = withStoreLock(file, () => gate.promise);
    await until(() => existsSync(lockDatabaseFor(file)));
    const events: string[] = [];
    const outcome = await withStoreLock(file, async () => "written", {
      timeoutMs: 40,
      onTimeout: "proceed",
      onEvent: (e) => events.push(e),
    });
    expect(outcome).toBe("written");
    expect(events).toEqual(["timeout"]);
    gate.resolve();
    await held;
  });

  test("the default policy fails closed on contention: no opts never proceeds unlocked (#216)", async () => {
    const file = join(tmp(), "a.logfmt");
    const gate = deferred();
    const held = withStoreLock(file, () => gate.promise);
    await until(() => existsSync(lockDatabaseFor(file)));
    const events: string[] = [];
    let ran = false;
    await expect(
      withStoreLock(
        file,
        async () => {
          ran = true;
          return "nope";
        },
        { timeoutMs: 40, onEvent: (e) => events.push(e) },
      ),
    ).rejects.toThrow(/busy/);
    expect(ran).toBe(false);
    expect(events).toEqual(["timeout"]);
    gate.resolve();
    await held;
  });

  test("the default policy fails closed when the queue hand-off times out (#216)", async () => {
    const file = join(tmp(), "a.logfmt");
    const gate = deferred();
    // A takes the lock and runs until the gate; B queues behind A's turn; C
    // queues behind B and gives up its place when A outlives the budget. The
    // hand-off give-up must fail closed under the default, not run C while A
    // still holds the store.
    const a = withStoreLock(file, () => gate.promise);
    await until(() => existsSync(lockDatabaseFor(file)));
    const b = withStoreLock(file, async () => "b");
    const events: string[] = [];
    let ran = false;
    await expect(
      withStoreLock(
        file,
        async () => {
          ran = true;
          return "c";
        },
        { timeoutMs: 40, onEvent: (e) => events.push(e) },
      ),
    ).rejects.toThrow(/busy/);
    expect(ran).toBe(false);
    expect(events).toEqual(["timeout"]);
    gate.resolve();
    await Promise.all([a, b]);
  });

  test("the default policy fails closed against another process's lock (#216)", async () => {
    // The DIRECT cross-process path #196 was about: no in-process queue, so the
    // give-up happens in the SQLite wait loop, not the hand-off. Reverting this
    // site to an explicit-fail check (`opts.onTimeout === "fail"`) runs THIS
    // write unlocked.
    const file = join(tmp(), "a.logfmt");
    const holder = await childHolder(file);
    const events: string[] = [];
    let ran = false;
    try {
      await expect(
        withStoreLock(
          file,
          async () => {
            ran = true;
            return "nope";
          },
          { timeoutMs: 40, onEvent: (e) => events.push(e) },
        ),
      ).rejects.toThrow(/busy/);
      expect(ran).toBe(false);
      expect(events).toEqual(["timeout"]);
    } finally {
      await holder.release();
    }
  });

  test("an acquisition creates nothing and deletes nothing in the store", async () => {
    // The #407 property, stated as an assertion. The lock file protocol created
    // a name and then asked the filesystem to remove it, and on Windows that
    // removal could be refused while a third-party handle was open — leaving an
    // entry that meant "held" with nobody holding it. WAL keeps -wal and -shm
    // alive for the life of the connection, so a normal acquisition performs no
    // create and no unlink at all.
    const root = tmp();
    const file = join(root, "a.logfmt");
    await withStoreLock(file, async () => appendLog(file, "ts=warm writer=p"));
    const before = readdirSync(root).sort();
    // The inodes, not just the names: a lock deleted and recreated on every
    // acquisition leaves the same listing, and that is exactly the behaviour
    // Windows refuses to perform.
    const artifacts = lockArtifacts(file);
    for (let i = 0; i < 25; i++) {
      await withStoreLock(file, async () => appendLog(file, `ts=t${i} w=p`));
    }
    expect(readdirSync(root).sort()).toEqual(before);
    expect(lockArtifacts(file)).toBe(artifacts);
  });

  test.skipIf(process.platform === "win32")(
    "a store rebuilt under a cached handle is reopened, not failed",
    async () => {
      // POSIX allows a directory to be deleted while a cached connection still
      // points into it; SQLite then answers the next write with SQLITE_IOERR and
      // the module reopens once rather than failing the write. Windows refuses
      // the delete outright — that boundary is `removeStore` and the README —
      // so this repair is only reachable here.
      const file = join(tmp(), "a.logfmt");
      await withStoreLock(file, async () => 1);
      const root = dirname(file);
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      expect(await withStoreLock(file, async () => "second")).toBe("second");
    },
  );

  test("closing releases idle handles and leaves a held one alone", async () => {
    // A cached connection is an open file, and Windows will not delete a
    // directory that contains one. Deleting a store is supported — the README
    // tells a user to reset their memories that way, and every fixture tears
    // its store down that way — so `closeAllLockDatabases` is the seam that
    // says "this process is done with stores". It must drop idle connections
    // (otherwise the delete is still EBUSY) and must NOT drop one inside a
    // section (that would hand the lock to another writer mid-transaction).
    // Two store directories: the lock database is per directory, so two files
    // in one store share one handle and cannot show idle-versus-held apart.
    const file = join(tmp(), "a.logfmt");
    const other = join(tmp(), "a.logfmt");
    const db = lockDatabaseFor(file);
    const otherDb = lockDatabaseFor(other);

    await withStoreLock(file, async () => 1);
    expect(heldLockDatabases().includes(db)).toBe(true); // the speed win: kept

    // Wait on acquisition, not on the handle: opening the database happens
    // before BEGIN IMMEDIATE, so a handle alone does not mean a section holds.
    const acquired: string[] = [];
    setLockAcquiredHook((f) => acquired.push(f));
    const gate = deferred();
    const holding = withStoreLock(other, () => gate.promise);
    await until(() => acquired.includes(other));
    closeAllLockDatabases();
    setLockAcquiredHook();
    // Idle one goes, in-section one stays.
    expect(heldLockDatabases().includes(db)).toBe(false);
    expect(heldLockDatabases().includes(otherDb)).toBe(true);

    gate.resolve();
    await holding;
    closeAllLockDatabases();
    expect(heldLockDatabases().includes(otherDb)).toBe(false);
  });

  test("a second process waits for the first to finish publishing", async () => {
    const root = tmp();
    const file = join(root, "shared.logfmt");
    const child = join(import.meta.dir, "helpers", "lock-holder.ts");
    // Held for ~500ms: long enough that the child reaches the lock while the
    // parent is still writing, so an ignored lock shows up as an interleaved
    // line instead of one that waited its turn.
    const holding = withStoreLock(file, async () => {
      for (let i = 0; i < 20; i++) {
        await appendLog(file, `ts=t${i} writer=parent`);
        await sleep(25);
      }
    });
    const p = Bun.spawn([process.execPath, child, file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await p.exited;
    const err = await new Response(p.stderr).text();
    await holding;
    expect(err.trim()).toBe("");
    expect(code).toBe(0);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[20]).toContain("writer=child"); // never interleaved
    expect(lines[19]).toContain("writer=parent");
  });
});

describe("re-entrancy", () => {
  test("a section nested in one this chain holds joins it", async () => {
    // memory_update and memory_merge_review hold a batch lock and then call
    // markSuperseded, which locks a day file. If that nested call queued behind
    // the FIFO the outer section owns, every update would wait its full timeout
    // and then refuse. SQLite refuses a second BEGIN on one connection outright,
    // so joining the outer transaction is the only correct outcome.
    const root = tmp();
    const [a, b] = [join(root, "a.logfmt"), join(root, "b.logfmt")];
    const outcome = await withStoreLock(a, async () => {
      const inner = await withStoreLock(b, async () => "inner");
      return `outer/${inner}`;
    });
    expect(outcome).toBe("outer/inner");
  });

  test("a sibling task does NOT inherit a lock another task holds", async () => {
    // MUST-GO-RED. Held state has to be scoped to the call chain. A module-level
    // set keyed by lock is process-wide, so this sibling reads "already held",
    // skips the lock, and writes while the holder is mid-read-modify-write —
    // silent data loss, and the exact failure the lock exists to prevent.
    // Measured: the first cut of the SQLite backend did this, and the
    // supersede-under-contention test resolved instead of refusing.
    const file = join(tmp(), "a.logfmt");
    const gate = deferred();
    const holder = withStoreLock(file, () => gate.promise);
    await until(() => existsSync(lockDatabaseFor(file)));
    let siblingRan = false;
    await expect(
      withStoreLock(
        file,
        async () => {
          siblingRan = true;
        },
        { timeoutMs: 40 },
      ),
    ).rejects.toThrow(/busy/);
    expect(siblingRan).toBe(false);
    gate.resolve();
    await holder;
  });
});

describe("broken lock database", () => {
  test("a lock database that cannot be opened fails fast and never runs the writer", async () => {
    // MUST-GO-RED for "every error is contention". A directory sitting where the
    // lock database belongs is not someone else holding the lock, so it must
    // surface its own cause at once. Treating it as busy would wait the whole
    // budget and then either report a misleading "busy" or, under the proceed
    // opt-in, write with no lock anywhere.
    const root = tmp();
    const file = join(root, "a.logfmt");
    mkdirSync(lockDatabaseFor(file));
    const started = Date.now();
    let ran = false;
    let message = "";
    try {
      await withStoreLock(
        file,
        async () => {
          ran = true;
        },
        { timeoutMs: 5000, onTimeout: "proceed" },
      );
    } catch (e) {
      message = String((e as Error).message ?? e);
    }
    expect(ran).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(message).toMatch(/cannot open|CANTOPEN|IOERR|directory/i);
    expect(message).not.toMatch(/busy/);
  });

  test("a corrupt lock database surfaces the corruption, not a busy refusal", async () => {
    const root = tmp();
    const file = join(root, "a.logfmt");
    writeFileSync(lockDatabaseFor(file), "this is not a sqlite database file");
    let ran = false;
    let message = "";
    try {
      await withStoreLock(
        file,
        async () => {
          ran = true;
        },
        { timeoutMs: 2000 },
      );
    } catch (e) {
      message = String((e as Error).message ?? e);
    }
    expect(ran).toBe(false);
    expect(message).toMatch(/not a database|corrupt/i);
    expect(message).not.toMatch(/busy/);
  });

  test("a store that cannot reach WAL mode is refused, not run in rollback mode", async () => {
    // Rollback-journal mode creates and then DELETES a journal file per
    // transaction — the Windows delete this module exists to remove. A store
    // that cannot do WAL must say so instead of quietly paying the old defect.
    // The assertion is on the connection this module keeps: it reports wal.
    const file = join(tmp(), "a.logfmt");
    await withStoreLock(file, async () => 1);
    const { Database } = await import("bun:sqlite");
    const probe = new Database(lockDatabaseFor(file));
    try {
      const mode = probe.query("PRAGMA journal_mode").get() as {
        journal_mode?: string;
      } | null;
      expect(String(mode?.journal_mode).toLowerCase()).toBe("wal");
    } finally {
      probe.close();
    }
  });

  test.skipIf(process.platform === "win32")(
    "the lock artifact is owner-only",
    async () => {
      // Same platform boundary as the `private store modes` suite: chmod on
      // Windows only toggles the read-only bit, so 0600 cannot be expressed and
      // stat reports 0666. Privacy there is the directory's ACL, which the
      // plugin does not change (README).
      const file = join(tmp(), "a.logfmt");
      await withStoreLock(file, async () => 1);
      const db = lockDatabaseFor(file);
      for (const suffix of ["", "-wal", "-shm"]) {
        const path = db + suffix;
        if (!existsSync(path)) continue;
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    },
  );
});

describe("crash recovery", () => {
  test("only the busy family is contention — the extended codes Bun reports", async () => {
    // MUST-GO-RED, deterministic. Bun puts the EXTENDED SQLite number on errno
    // (261 for BUSY_RECOVERY, not 5) and the extended NAME on code, so a check
    // written against plain SQLITE_BUSY classifies the post-crash wait as a
    // fatal error. The integration test below can only catch that by scheduling
    // luck; this one catches it every time.
    const busy = (code: string, errno: number) =>
      Object.assign(new Error("database is locked"), { code, errno });
    // Waited for.
    expect(isLockContention(busy("SQLITE_BUSY", 5))).toBe(true);
    expect(isLockContention(busy("SQLITE_BUSY_RECOVERY", 261))).toBe(true);
    expect(isLockContention(busy("SQLITE_BUSY_SNAPSHOT", 517))).toBe(true);
    expect(isLockContention(busy("SQLITE_BUSY_TIMEOUT", 773))).toBe(true);
    // Code missing, class still readable from the low byte.
    expect(isLockContention({ errno: 261 })).toBe(true);
    // Thrown: nothing to wait for, and waiting would end in a refusal anyway.
    expect(isLockContention(busy("SQLITE_CANTOPEN", 14))).toBe(false);
    expect(isLockContention(busy("SQLITE_NOTADB", 26))).toBe(false);
    expect(isLockContention(busy("SQLITE_IOERR", 10))).toBe(false);
    expect(isLockContention(busy("SQLITE_READONLY", 8))).toBe(false);
    expect(isLockContention(new Error("boom"))).toBe(false);
  });

  test("the first writers after a killed holder wait out recovery instead of failing", async () => {
    // MUST-GO-RED for the busy predicate. SQLite answers a connection that
    // arrives while another is recovering the write-ahead log with the EXTENDED
    // code SQLITE_BUSY_RECOVERY, and Bun reports it as errno 261 with the name
    // on `code`. Matching only plain SQLITE_BUSY turned the one situation this
    // lock is built to survive — a holder that died — into a fatal
    // "store lock unavailable: database is locked". Measured: this is exactly
    // how test/scenarios-consistency.test.ts failed before the fix.
    const root = tmp();
    const file = join(root, "crash.logfmt");
    writeFileSync(file, "ts=seed writer=seed\n");
    const holder = await childHolder(file, "ts=crashed writer=child");
    holder.crash();
    await holder.proc.exited;
    // Two openers at once: one performs the recovery, the other is refused with
    // a busy-family code and must retry. Both must succeed.
    const results = await Promise.allSettled([
      withStoreLock(file, async () => appendLog(file, "ts=w1 writer=a"), {
        timeoutMs: 5000,
      }),
      withStoreLock(file, async () => appendLog(file, "ts=w2 writer=b"), {
        timeoutMs: 5000,
      }),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        throw new Error(
          `a writer after a crash was refused: ${(r.reason as Error).message}`,
        );
      }
    }
    // Four lines: the seed, the killed holder's own append, and the two writers
    // that had to wait out recovery. The holder's append survives because the
    // data file is handed over by rename, not by the lock — the lock decides
    // WHO may rewrite, not whether a completed write is durable.
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.includes("writer=child"))).toBe(true);
  });
});

describe("deadline races", () => {
  test("contention only ever surfaces the busy refusal, never a raw store error", async () => {
    // Regression (#107, re-anchored for the SQLite backend): the give-up path
    // must report the policy's outcome, not an error left over from an earlier
    // attempt. A live competing holder is driven here for real, across the
    // deadline, repeatedly.
    const root = tmp();
    const file = join(root, "release-race.logfmt");
    writeFileSync(file, "");
    const messages: string[] = [];
    for (let i = 0; i < 12; i++) {
      const holder = await childHolder(file, `ts=race${i} writer=child`);
      try {
        await withStoreLock(file, async () => "ok", { timeoutMs: 30 });
      } catch (e) {
        messages.push(String((e as Error).message ?? e));
      } finally {
        await holder.release();
      }
    }
    expect(messages.length).toBeGreaterThan(0); // contention really did happen
    for (const m of messages) expect(m).toMatch(/busy/);
  });
});

describe.skipIf(process.platform !== "win32")(
  "broken store directory (Windows ACL)",
  () => {
    test("fails fast with the real error and never runs the writer", async () => {
      // A directory we cannot create files in is NOT a contention case: there is
      // no holder to wait for, so the failure must surface in tens of ms — not
      // decay into the budget timeout, whose "proceed" would run the write with
      // no lock anywhere. Emit starts too: an outer timeout can kill the worker
      // before a phase finishes. Log phase names/durations only, never usernames
      // or temp paths.
      const startPhase = (phase: string) => {
        console.info(
          `[acl-fixture] ${JSON.stringify({ phase, event: "start" })}`,
        );
        const started = performance.now();
        return (exitCode?: number) =>
          console.info(
            `[acl-fixture] ${JSON.stringify({
              phase,
              event: "end",
              elapsedMs: Math.round(performance.now() - started),
              exitCode: exitCode ?? null,
            })}`,
          );
      };
      const measure = <T>(phase: string, fn: () => T): T => {
        const end = startPhase(phase);
        let exitCode: number | undefined;
        try {
          const result = fn();
          if (
            result &&
            typeof result === "object" &&
            "exitCode" in result &&
            typeof result.exitCode === "number"
          ) {
            exitCode = result.exitCode;
          }
          return result;
        } finally {
          end(exitCode);
        }
      };
      const store = measure("setup", () => {
        const dir = tmp();
        const path = join(dir, "memory");
        mkdirSync(path);
        return path;
      });
      const file = join(store, "a.logfmt");
      const me =
        measure("identity", () => Bun.spawnSync(["whoami"], { stdout: "pipe" }))
          .stdout?.toString()
          .trim() ?? "";
      const icacls = (args: string[]) =>
        Bun.spawnSync(["icacls", store, ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });
      const deny = measure("acl-deny", () => icacls(["/deny", `${me}:(WD)`]));
      if (deny.exitCode !== 0) {
        console.info(
          '[acl-fixture] {"event":"not-exercised","reason":"acl-deny-failed"}',
        );
        return;
      }
      try {
        let denied = false;
        try {
          measure("deny-probe", () =>
            writeFileSync(join(store, "probe.txt"), "x"),
          );
        } catch {
          denied = true;
        }
        if (!denied) {
          console.info(
            '[acl-fixture] {"event":"not-exercised","reason":"denial-not-effective"}',
          );
          return;
        }
        let ran = false;
        const endLock = startPhase("lock");
        const t0 = Date.now();
        let lockMs = 0;
        let failed = false;
        let message = "";
        try {
          await withStoreLock(
            file,
            async () => {
              ran = true;
              await Bun.write(file, "x");
            },
            { timeoutMs: 5000 },
          );
        } catch (e) {
          failed = true;
          message = String((e as Error).message ?? e);
        } finally {
          lockMs = Date.now() - t0;
          endLock();
        }
        expect(ran).toBe(false);
        expect(failed).toBe(true);
        expect(lockMs).toBeLessThan(2000);
        // SQLite flattens a refused open to its own code, so the assertion names
        // both the flattening and the errno it replaced. The path is in the
        // message either way: see lockDatabase.
        expect(message).toMatch(
          /CANTOPEN|IOERR|EPERM|EACCES|permission|unable to open/i,
        );
      } finally {
        measure("acl-restore", () => icacls(["/remove:d", me]));
      }
      // The outer budget includes whoami and ACL setup/cleanup subprocesses on
      // shared Windows runners. The lock itself must still fail within 2s above.
    }, 30_000);
  },
);
