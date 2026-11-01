import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { loadAll } from "../src/store/files/load.ts";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { appendLog, ensureDir, writeAtomic } from "../src/core/logfmt/publish.ts";
import { snapshotFiles } from "../src/store/files/snapshots.ts";
import { withStoreLock, lockFileFor, LOCK_WRITE } from "../src/store/lock.ts";
import { preparePrivateFile } from "../src/core/permissions.ts";
import { readStatus, writeStatus, statusFile, sessionStatusFile } from "../src/status/write.ts";
import type { StatusPayload } from "../src/status/payload.ts";

// Windows chmod does not represent ACL privacy. Exercise these guarantees on
// POSIX with a permissive umask, rather than passing vacuous Windows checks.
describe.skipIf(process.platform === "win32")("private store modes", () => {
  let parent: string;
  let root: string;
  let oldDir: string | undefined;
  let oldMask: number;
  const mode = (path: string) => statSync(path).mode & 0o777;
  beforeEach(() => {
    oldDir = process.env.OPENCODE_MEMORY_DIR;
    oldMask = process.umask(0);
    parent = mkdtempSync(join(tmpdir(), "osi218-"));
    chmodSync(parent, 0o755);
    root = join(parent, "store");
    process.env.OPENCODE_MEMORY_DIR = root;
  });
  afterEach(() => {
    process.umask(oldMask);
    if (oldDir === undefined) delete process.env.OPENCODE_MEMORY_DIR;
    else process.env.OPENCODE_MEMORY_DIR = oldDir;
    rmSync(parent, { recursive: true, force: true });
  });

  test("resolving an existing store protects its root without changing its parent or rewriting history", () => {
    mkdirSync(root, { mode: 0o755 });
    const old = join(root, "old.logfmt");
    writeFileSync(old, "old private history\n", { mode: 0o644 });
    expect(memoryRoot()).toBe(root);
    expect(mode(root)).toBe(0o700);
    expect(mode(parent)).toBe(0o755);
    expect(readFileSync(old, "utf8")).toBe("old private history\n");
    // The root blocks traversal; this is not a recursive migration of old files.
    expect(mode(old)).toBe(0o644);
  });

  test("new intermediate store directories and appended ledgers are private", async () => {
    const dir = join(root, "evidence", "nested");
    const file = join(dir, "events.logfmt");
    await appendLog(file, "event=first");
    for (const path of [root, join(root, "evidence"), dir]) expect(mode(path)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    chmodSync(dir, 0o755);
    chmodSync(file, 0o644);
    await appendLog(file, "event=second");
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("event=first\nevent=second\n");
    expect(mode(parent)).toBe(0o755);
  });

  test("atomic publication and snapshots are private before sensitive bytes are written", async () => {
    mkdirSync(root, { mode: 0o755 });
    const file = join(root, "2026-01-01.logfmt");
    writeFileSync(file, "old\n", { mode: 0o644 });
    const original = Bun.write;
    const observed: string[] = [];
    const spy = spyOn(Bun, "write").mockImplementation(async (destination, data, options) => {
      if (typeof destination === "string" && destination.startsWith(root)) {
        observed.push(destination);
        expect(mode(destination)).toBe(0o600);
      }
      return Reflect.apply(original, Bun, [destination, data, options]);
    });
    try {
      await writeAtomic(file, "new\n");
      const [snapshot] = await snapshotFiles([file]);
      expect(observed).toHaveLength(2);
      expect(mode(file)).toBe(0o600);
      expect(mode(snapshot)).toBe(0o600);
      expect(mode(join(root, "snapshots"))).toBe(0o700);
      expect(readFileSync(snapshot, "utf8")).toBe("new\n");
    } finally { spy.mockRestore(); }
  });

  test("the first lock creates a private store directory and lock file", async () => {
    const file = join(root, "day.logfmt");
    await withStoreLock(file, async () => {
      expect(mode(root)).toBe(0o700);
      expect(mode(lockFileFor(file))).toBe(0o600);
    }, LOCK_WRITE);
  });

  test("status publication prepares private new and existing files without truncating first", () => {
    const file = join(root, "status", "session.json");
    preparePrivateFile(file);
    expect(mode(file)).toBe(0o600);
    expect(mode(root)).toBe(0o700);
    expect(mode(join(root, "status"))).toBe(0o700);
    writeFileSync(file, "existing");
    chmodSync(file, 0o644);
    preparePrivateFile(file);
    expect(mode(file)).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("existing");
  });

  test("tightening directory modes preserves owner read-only intent", async () => {
    mkdirSync(root, { mode: 0o555 });
    try {
      await ensureDir(root);
      expect(mode(root)).toBe(0o500);
    } finally { chmodSync(root, 0o700); }
  });

  test.each(["EPERM", "EROFS", "EOPNOTSUPP", "ENOSYS"])("a readable root remains usable when directory chmod reports %s", async (code) => {
    mkdirSync(root, { mode: 0o755 });
    writeFileSync(join(root, "2026-01-01.logfmt"), 'ts=2026-01-01T00:00:00.000Z type=learning scope=build content="existing memory"\n');
    const spy = spyOn(fs, "fchmodSync").mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    try {
      expect(memoryRoot()).toBe(root);
      await ensureDir(root);
      expect((await loadAll()).map((row) => row.content)).toEqual(["existing memory"]);
      expect(spy).toHaveBeenCalled();
      expect(mode(root)).toBe(0o755); // The fallback cannot promise a private traversal barrier.
    } finally { spy.mockRestore(); }
  });

  test("unexpected directory chmod failures still propagate", () => {
    mkdirSync(root, { mode: 0o755 });
    const spy = spyOn(fs, "fchmodSync").mockImplementation(() => { throw Object.assign(new Error("disk failure"), { code: "EIO" }); });
    try { expect(() => memoryRoot()).toThrow("disk failure"); }
    finally { spy.mockRestore(); }
  });

  test("the status writer publishes both private files and tightens existing ones before writing", async () => {
    const sessionID = "ses_private";
    const payload: StatusPayload = {
      at: "2026-01-01T00:00:00Z", sessionID, reason: "first", recomputes: 1,
      block: "private memory", blockChars: 14, budget: 1200,
      store: { active: 1, superseded: 0, open: 0, scopes: 1, malformed: 0 },
    };
    const original = Bun.write;
    let writes = 0;
    const spy = spyOn(Bun, "write").mockImplementation(async (destination, data, options) => {
      if (typeof destination === "string" && destination.startsWith(root)) {
        writes++;
        expect(mode(destination)).toBe(0o600);
      }
      return Reflect.apply(original, Bun, [destination, data, options]);
    });
    try {
      await writeStatus(payload);
      expect(writes).toBe(2);
      for (const file of [statusFile(), sessionStatusFile(sessionID)]) chmodSync(file, 0o644);
      await writeStatus({ ...payload, block: "updated" });
      expect(writes).toBe(4);
      expect((await readStatus())?.block).toBe("updated");
      expect((await readStatus(payload.sessionID))?.block).toBe("updated");
      expect(mode(root)).toBe(0o700);
      expect(mode(join(root, "status"))).toBe(0o700);
    } finally { spy.mockRestore(); }
  });

  test("a root symlink or appended file symlink cannot chmod an outside target", async () => {
    const outside = join(parent, "outside");
    mkdirSync(outside, { mode: 0o755 });
    symlinkSync(outside, root);
    expect(() => memoryRoot()).toThrow();
    expect(mode(outside)).toBe(0o755);
    rmSync(root);
    mkdirSync(root, { mode: 0o700 });
    const target = join(outside, "target.logfmt");
    writeFileSync(target, "unchanged\n", { mode: 0o644 });
    const link = join(root, "link.logfmt");
    symlinkSync(target, link);
    await expect(appendLog(link, "changed")).rejects.toThrow();
    expect(mode(target)).toBe(0o644);
    expect(readFileSync(target, "utf8")).toBe("unchanged\n");
  });
});
