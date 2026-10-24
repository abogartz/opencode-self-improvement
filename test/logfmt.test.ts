// logfmt round-trip. One record is one line: values containing newlines,
// backslashes or quotes must come back intact and must never split into a
// second record.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoot } from "../src/config.ts";
import { appendLog, formatLine, parseLine, readLines } from "../src/logfmt.ts";
import { appendMemory, loadAll, markSuperseded } from "../src/memory.ts";

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
