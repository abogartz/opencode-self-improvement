// A reader must use metadata and bytes from the same opened file. An atomic
// replacement may change the path between the metadata lookup and the read.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLines } from "../src/core/logfmt/read.ts";
import { replaceWithCachedHandle } from "./helpers/cached-handle.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-read-replace-"));
});
afterEach(() => {
  removeStore(root);
});

test("a larger atomic replacement is not cropped to the previous file size", async () => {
  const file = join(root, "day.logfmt");
  const rows = [
    `ts=new content="${"x".repeat(10_000)}"`,
    'ts=tail content="the final row must survive"',
  ];
  // The helper supplies the actual BunFile whose metadata predates the
  // rename: no sleeps, no mocked bytes, both readers see the real file.
  const restore = await replaceWithCachedHandle(
    file,
    rows.join("\n") + "\n",
    'ts=old content="short"\n',
  );
  try {
    const lines = await readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(rows[0]);
    expect(lines[1]).toBe(rows[1]);
  } finally {
    restore();
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
