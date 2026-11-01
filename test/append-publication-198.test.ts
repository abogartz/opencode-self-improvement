// Daily-memory publication boundary and Windows availability tradeoff (#198).
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoryRoot } from "../src/core/config/paths.ts"
import { dateStr } from "../src/core/time.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { formatLine, parseLine } from "../src/core/logfmt/format.ts"
import { readLines } from "../src/core/logfmt/read.ts";

let root: string;
let file: string;
let previousDir: string | undefined;
const seed = formatLine({ ts: "2000-01-01T00:00:00.000Z", type: "learning", scope: "probe", content: "original intact content" });
const input = { type: "learning", scope: "probe", content: "new complete content", repo: "global" };

beforeEach(() => {
  previousDir = process.env.OPENCODE_MEMORY_DIR;
  root = mkdtempSync(join(tmpdir(), "osi198-publication-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  mkdirSync(memoryRoot(), { recursive: true });
  file = join(memoryRoot(), `${dateStr()}.logfmt`);
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.OPENCODE_MEMORY_DIR;
  else process.env.OPENCODE_MEMORY_DIR = previousDir;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

test("a static unterminated row survives a subsequent daily append", async () => {
  writeFileSync(file, seed);
  expect(await readLines(file)).toEqual([seed]);
  const ts = await appendMemory(input);
  const rows = await readLines(file);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toBe(seed);
  expect(parseLine(rows[1])).toMatchObject({ ts, content: input.content });
});

test("readers retain the old file while the replacement is only partially written", async () => {
  writeFileSync(file, `${seed}\n`);
  const originalWrite = Bun.write;
  let intercepted = false;
  const spy = spyOn(Bun, "write").mockImplementation(async (destination, data, options) => {
    if (typeof destination === "string" && destination.startsWith(`${file}.`) && destination.endsWith(".tmp")) {
      intercepted = true;
      expect(typeof data).toBe("string");
      const text = String(data);
      const cut = text.indexOf(input.content) + 3;
      expect(cut).toBeGreaterThan(seed.length);
      await originalWrite(destination, text.slice(0, cut));
      expect(readFileSync(destination, "utf8").endsWith("\n")).toBe(false);
      expect(await readLines(file)).toEqual([seed]);
    }
    return Reflect.apply(originalWrite, Bun, [destination, data, options]);
  });
  try {
    const ts = await appendMemory(input);
    expect(intercepted).toBe(true);
    const rows = await readLines(file);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(seed);
    expect(parseLine(rows[1])).toMatchObject({ ts, content: input.content });
    expect(readdirSync(memoryRoot()).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test.skipIf(process.platform !== "win32")("a held Windows reader causes a refused append with the original bytes intact; retry succeeds after release", async () => {
  writeFileSync(file, `${seed}\n`);
  const fd = openSync(file, "r");
  try {
    // Establish that this handle really blocks replacement on this runtime.
    const { rename } = await import("node:fs/promises");
    const candidate = join(memoryRoot(), "premise.tmp");
    writeFileSync(candidate, "candidate\n");
    await expect(rename(candidate, file)).rejects.toThrow();
    rmSync(candidate);
    await expect(appendMemory(input)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(`${seed}\n`);
    expect(readdirSync(memoryRoot()).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
  } finally {
    closeSync(fd);
  }
  const ts = await appendMemory(input);
  const rows = await readLines(file);
  expect(rows).toHaveLength(2);
  expect(parseLine(rows[1])).toMatchObject({ ts, content: input.content });
}, 10000);
