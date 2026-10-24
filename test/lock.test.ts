// The lock contract: one writer per file across processes and across async
// tasks inside one process; a dead holder is recovered by age; waiting past the
// timeout either fails closed or proceeds; and a holder whose lock was taken
// over never deletes the new one.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog } from "../src/logfmt.ts";
import { lockFileFor, withStoreLock } from "../src/lock.ts";

const roots: string[] = [];
function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), "osi-lock-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    expect(existsSync(lockFileFor(file))).toBe(false);
    const started = Date.now();
    expect(await withStoreLock(file, async () => "next")).toBe("next");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("different files are not contended", async () => {
    const root = tmp();
    const [a, b] = [join(root, "a.logfmt"), join(root, "b.logfmt")];
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

  test("a lock left behind by a dead process is taken over", async () => {
    const file = join(tmp(), "a.logfmt");
    const lock = lockFileFor(file);
    writeFileSync(lock, "99999-dead-token");
    const dead = new Date(Date.now() - 60_000);
    utimesSync(lock, dead, dead);
    const events: string[] = [];
    const outcome = await withStoreLock(file, async () => "ran", {
      onEvent: (e) => events.push(e),
    });
    expect(outcome).toBe("ran");
    expect(events).toEqual(["steal"]);
  });

  test("a fresh lock is NOT stale: waiting past the timeout fails closed", async () => {
    const file = join(tmp(), "a.logfmt");
    const gate = deferred();
    const held = withStoreLock(file, () => gate.promise);
    await until(() => existsSync(lockFileFor(file)));
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

  test("proceed mode runs the write unlocked and reports it", async () => {
    const file = join(tmp(), "a.logfmt");
    const gate = deferred();
    const held = withStoreLock(file, () => gate.promise);
    await until(() => existsSync(lockFileFor(file)));
    const events: string[] = [];
    const outcome = await withStoreLock(file, async () => "written", {
      timeoutMs: 40,
      onEvent: (e) => events.push(e),
    });
    expect(outcome).toBe("written");
    expect(events).toEqual(["timeout"]);
    gate.resolve();
    await held;
  });

  test("a holder whose lock was taken over does not delete it", async () => {
    const file = join(tmp(), "a.logfmt");
    const lock = lockFileFor(file);
    const gate = deferred();
    const held = withStoreLock(file, () => gate.promise);
    await until(() => existsSync(lock));
    unlinkSync(lock);
    writeFileSync(lock, "someone-elses-token");
    gate.resolve();
    await held;
    expect(readFileSync(lock, "utf8")).toBe("someone-elses-token");
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
    const p = Bun.spawn([process.execPath, child, file], { stdout: "pipe", stderr: "pipe" });
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
