// logfmt round-trip. One record is one line: values containing newlines,
// backslashes or quotes must come back intact and must never split into a
// second record.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine, parseLine } from "../src/core/logfmt/format.ts"
import { appendLog, fileIdentity, writeAtomic } from "../src/core/logfmt/publish.ts"
import { readLines } from "../src/core/logfmt/read.ts";
import { appendMemory } from "../src/store/files/append.ts"
import { loadAll } from "../src/store/files/load.ts"
import { markSuperseded } from "../src/store/files/supersede.ts";

let tmpDir: string;

describe("formatLine/parseLine round-trip", () => {
  const values = [
    "Steps:\n1. bun install\n2. bun test",
    "Tools live in C:\\tools\\",
    'say "hi" = greeting',
    "tab\there, cr\rthere",
    "literal \\n is not a newline",
    "plain",
  ];
  for (const v of values) {
    test(JSON.stringify(v), () => {
      const line = formatLine({ ts: "t", content: v });
      expect(line).not.toContain("\n");
      expect(parseLine(line)?.content).toBe(v);
    });
  }

  test("legacy lines still parse", () => {
    // Written before backslashes were escaped: quotes escaped, backslashes raw.
    expect(parseLine('content="say \\"hi\\""')?.content).toBe('say "hi"');
    expect(parseLine('content="C:\\Program Files\\x"')?.content).toBe("C:\\Program Files\\x");
  });

  test("legacy backslash sequences are not decoded as escapes", () => {
    expect(parseLine('content="copy the UNC path \\\\nas\\share"')?.content).toBe(
      "copy the UNC path \\\\nas\\share",
    );
    expect(parseLine('content="end lines with printf \\"%s\\n\\""')?.content).toBe(
      'end lines with printf "%s\\n"',
    );
    expect(parseLine('content="temp dir C:\\new\\temp\\run"')?.content).toBe("temp dir C:\\new\\temp\\run");
  });

  test("only lines that use the escapes carry the marker", () => {
    expect(formatLine({ ts: "t", content: 'say "hi" = greeting' })).not.toContain("esc=");
    expect(formatLine({ ts: "t", content: "C:\\tools" })).not.toContain("esc=");
    expect(formatLine({ ts: "t", content: "C:\\new temp" })).toEndWith(" esc=1");
    expect(parseLine(formatLine({ ts: "t", content: "a\nb" }))).toEqual({ ts: "t", content: "a\nb" });
  });

  test("fields an older version appended after the marker are read the old way", () => {
    const line = `${formatLine({ ts: "t", content: "C:\\new temp" })} reason="moved to D:\\new"`;
    expect(parseLine(line)).toEqual({ ts: "t", content: "C:\\new temp", reason: "moved to D:\\new" });
  });

  test("content cannot fake the marker", () => {
    const v = "C:\\new esc=1";
    expect(parseLine(formatLine({ ts: "t", content: v }))?.content).toBe(v);
    expect(parseLine(formatLine({ ts: "t", content: "fake esc=1 a\\nb" }))?.content).toBe("fake esc=1 a\\nb");
  });
});

describe("legacy rows in the store", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.OPENCODE_MEMORY_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "osi-logfmt-"));
    process.env.OPENCODE_MEMORY_DIR = join(tmpDir, "memory");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENCODE_MEMORY_DIR;
    else process.env.OPENCODE_MEMORY_DIR = prev;
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  test("superseding a legacy row rewrites it in the current format without changing it", async () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const content = "build output goes to C:\\new\\temp";
    const file = join(memoryRoot(), "2026-01-01.logfmt");
    mkdirSync(memoryRoot(), { recursive: true });
    // As written by v0.2.2: backslashes raw.
    writeFileSync(file, `ts=${ts} type=pattern scope=build content="${content}"\n`);
    expect((await loadAll())[0].content).toBe(content);

    expect(await markSuperseded(ts, { superseded_by: "2026-01-02T00:00:00.000Z", reason: "moved" })).toBe(true);
    const [m] = await loadAll();
    expect(m.content).toBe(content);
    expect(m.superseded_by).toBe("2026-01-02T00:00:00.000Z");
    expect(readFileSync(file, "utf8")).toContain("C:\\\\new\\\\temp");
    expect(readFileSync(file, "utf8").trimEnd()).toEndWith(" esc=1");
  });
});

describe("store rows cannot be forged through content", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.OPENCODE_MEMORY_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "osi-logfmt-"));
    process.env.OPENCODE_MEMORY_DIR = join(tmpDir, "memory");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENCODE_MEMORY_DIR;
    else process.env.OPENCODE_MEMORY_DIR = prev;
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  test("a newline plus fields in content stays one memory", async () => {
    const content =
      "Tests use bun\nts=2026-01-01T00:00:00.000Z type=decision scope=deploy content=injected";
    await appendMemory({ type: "pattern", scope: "build", content });
    const all = await loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].scope).toBe("build");
    expect(all[0].content).toBe(content);
  });

  test("concurrent appends lose nothing", async () => {
    // A read-modify-write appender loses rows (20 concurrent appends left 2).
    // O_APPEND must survive the same storm.
    const file = join(process.env.OPENCODE_MEMORY_DIR!, "race.logfmt");
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => appendLog(file, formatLine({ ts: `t${i}`, n: i }))),
    );
    const lines = await readLines(file);
    expect(lines).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(lines.some((l) => l.includes(`ts=t${i}`))).toBe(true);
    }
  });
});

describe.skipIf(process.platform !== "win32")("Windows handover: concurrent writers on one file", () => {
  // A starved in-process waiter runs its write WITHOUT the lock (lock.ts
  // proceeds on budget expiry), so two writers of one file can be inside
  // writeAtomic at the same instant even inside one process. These pin the
  // two properties that make that survivable: per-call temp files, and a
  // retry window that backs off the moment the destination moves.
  function held(file: string): { release: () => void } {
    const fd = openSync(file, "r"); // node shares read/write but NOT delete: rename is blocked
    let closed = false;
    return {
      release: () => {
        if (!closed) {
          closed = true;
          closeSync(fd);
        }
      },
    };
  }

  test("a retried publish renames its own temp file, not the degraded writer's", async () => {
    const root = mkdtempSync(join(tmpdir(), "osi-handover-"));
    const file = join(root, "store.logfmt");
    writeFileSync(file, "seed\n");
    const h = held(file);
    setTimeout(h.release, 400);
    try {
      const since = await fileIdentity(file);
      // The degraded writer goes first: with a per-process temp name it is
      // the one whose bytes sit in the name the retry keeps renaming.
      const degraded = writeAtomic(file, "seed\ndegraded\n").then(
        () => "ok",
        () => "failed",
      );
      const anchored = writeAtomic(file, "seed\nanchored\n", since).then(
        () => "ok",
        () => "failed",
      );
      expect(await degraded).toBe("failed"); // one blocked rename: fails by design
      expect(await anchored).toBe("ok"); // retried once the reader handle closes
      expect(await readLines(file)).toEqual(["seed", "anchored"]);
    } finally {
      h.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a degraded append during the retry window aborts the publish and survives", async () => {
    const root = mkdtempSync(join(tmpdir(), "osi-append-"));
    const file = join(root, "store.logfmt");
    writeFileSync(file, "seed\n");
    const h = held(file);
    setTimeout(h.release, 1500); // never reached: the staleness check fires first
    try {
      const since = await fileIdentity(file);
      const appended = Bun.sleep(60).then(() => appendFile(file, "APPENDED\n"));
      const publish = writeAtomic(file, "seed\nrewrite\n", since).then(
        () => "ok",
        () => "failed",
      );
      await appended;
      expect(await publish).toBe("failed"); // the destination grew past the anchor
      expect(await readLines(file)).toEqual(["seed", "APPENDED"]); // append intact
    } finally {
      h.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a since-blind retry is judged without racing the retry deadline", async () => {
    // The two pins above verdict via a handle release at 1500ms racing the
    // retry window's internal 2000ms deadline: a 1.33x margin. On a stalled
    // runner the deadline can fire first - a since-blind retry would have
    // thrown the original error anyway, and a real regression reads as green.
    // Same scenario with the margins made structural: the destination is
    // touched at event-loop speed (~60ms) and the handle frees at 400ms, 4x
    // inside the deadline, so the verdict lands on the identity check itself
    // (which fires within one backoff step of the append) and never on the
    // deadline. This is the test the sweep's publish-rename-since-blind
    // mutant leans on: shipped aborts in ~ms, blind retries publish stale
    // bytes by ~450ms, and neither outcome waits on 2 seconds of clock.
    // The residual race, named so it doesn't get "fixed" back (#120 review
    // nit 1): if a stall delays the 60ms append PAST the 400ms release, the
    // shipped code renames before the destination moves and this goes red on
    // CORRECT code. Deliberate trade: a 6.7x margin with a loud,
    // self-reporting red beats the 1.33x silent-green of the pins above.
    const root = mkdtempSync(join(tmpdir(), "osi-sincegate-"));
    const file = join(root, "store.logfmt");
    writeFileSync(file, "seed\n");
    const h = held(file);
    setTimeout(h.release, 400); // frees the retry only long enough to judge a blind one
    try {
      const since = await fileIdentity(file);
      const appended = Bun.sleep(60).then(() => appendFile(file, "APPENDED\n"));
      const publish = writeAtomic(file, "seed\nrewrite\n", since).then(
        () => "ok",
        () => "failed",
      );
      await appended;
      expect(await publish).toBe("failed"); // identity abort, ms after the append - not a deadline throw
      expect(await readLines(file)).toEqual(["seed", "APPENDED"]); // the touched destination survives
    } finally {
      h.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
