// A reader must use metadata and bytes from the same opened file. An atomic
// replacement may change the path between the metadata lookup and the read.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLines } from "../src/core/logfmt/read.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-read-replace-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

test("a larger atomic replacement is not cropped to the previous file size", async () => {
  const file = join(root, "day.logfmt");
  writeFileSync(file, 'ts=old content="short"\n');
  const cached = Bun.file(file);
  expect(await cached.exists()).toBe(true);

  const rows = [
    `ts=new content="${"x".repeat(10_000)}"`,
    'ts=tail content="the final row must survive"',
  ];
  const next = join(root, "replacement.tmp");
  writeFileSync(next, rows.join("\n") + "\n");
  renameSync(next, file);

  // Supply the actual BunFile whose metadata predates the rename. This pins
  // the exists()/text() race without sleeps or mocking the bytes returned:
  // both old and new reader implementations read the real replacement file.
  const realFile = Bun.file;
  const factory = spyOn(Bun, "file").mockImplementation((path: unknown, options?: BlobPropertyBag) =>
    path === file ? cached : Reflect.apply(realFile, Bun, [path, options]),
  );
  try {
    const lines = await readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(rows[0]);
    expect(lines[1]).toBe(rows[1]);
  } finally {
    factory.mockRestore();
  }
});

test("missing and empty files remain empty; whitespace-only lines are omitted", async () => {
  const file = join(root, "day.logfmt");
  expect(await readLines(file)).toEqual([]);
  writeFileSync(file, "");
  expect(await readLines(file)).toEqual([]);
  writeFileSync(file, '\n  \n ts=one content="kept"\n\t\n');
  expect(await readLines(file)).toEqual([' ts=one content="kept"']);
});

test("non-ENOENT read errors propagate instead of looking like an empty store", async () => {
  await expect(readLines(root)).rejects.toMatchObject({ code: "EISDIR" });
});
