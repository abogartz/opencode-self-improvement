import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { snapshotFiles } from "../src/store/files/snapshots.ts"
import { type Memory } from "../src/store/model/memory.ts";
import { removeBlock, blocklistFile } from "../src/store/blocklist.ts";
import { hitsFile, recordHits, resetHitThrottle } from "../src/hits/ledger.ts";
import { restoreSnapshot } from "../src/store/undo.ts";
import { importMemories } from "../src/portable/import.ts";
import { readStatus, statusFile } from "../src/status/write.ts";
import { resetState } from "../src/core/state.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";

let root: string;
let old: string | undefined;
let restore = () => {};
beforeEach(() => {
  old = process.env.OPENCODE_MEMORY_DIR;
  root = mkdtempSync(join(tmpdir(), "osi-complete-reads-"));
  process.env.OPENCODE_MEMORY_DIR = root;
  resetState(); resetSessionScopes(); setRepoScope(null); resetHitThrottle();
});
afterEach(() => {
  restore();
  resetState(); resetSessionScopes(); setRepoScope(null); resetHitThrottle();
  if (old === undefined) delete process.env.OPENCODE_MEMORY_DIR;
  else process.env.OPENCODE_MEMORY_DIR = old;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("osi-complete-reads-")) throw new Error("Unexpected fixture root");
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
// Only the factory is intercepted: the returned handle reads real replacement
// bytes with genuinely stale metadata. Every unrelated path uses real Bun.file.
async function replaceWithCachedHandle(file: string, text: string, before = "short\n") {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, before);
  const cached = Bun.file(file);
  expect(await cached.exists()).toBe(true);
  writeFileSync(`${file}.next`, text);
  renameSync(`${file}.next`, file);
  const real = Bun.file;
  const spy = spyOn(Bun, "file").mockImplementation((path: unknown, options?: BlobPropertyBag) =>
    path === file ? cached : Reflect.apply(real, Bun, [path, options]));
  restore = () => spy.mockRestore();
}
const day = () => join(root, "2026-10-29.logfmt");
const row = (ts: string, content: string) => `ts=${ts} type=context scope=plan content="${content}"\n`;

test("Bun cached-size premise: replacement text is cropped until the runtime is fixed", async () => {
  // Deliberately fails when Bun fixes this: re-audit the readers and their
  // negative controls instead of letting the cached-handle seam go vacuous.
  // Distinct prefixes distinguish truncation from a valid old-version read.
  const file = day();
  writeFileSync(file, "AAAAA");
  const cached = Bun.file(file);
  expect(await cached.exists()).toBe(true);
  const replacement = "B".repeat(37);
  writeFileSync(`${file}.next`, replacement);
  renameSync(`${file}.next`, file);
  expect(readFileSync(file, "utf8")).toBe(replacement);
  expect(await cached.text()).toBe("BBBBB");
  expect(await cached.text()).toBe("BBBBB");
});

test("snapshot copies complete bytes including BOM and trailing newline", async () => {
  const text = "\uFEFF" + row("one", "x".repeat(10000)) + row("tail", "last row");
  await replaceWithCachedHandle(day(), text);
  const [snap] = await snapshotFiles([day()]);
  expect(readFileSync(snap)).toEqual(Buffer.from(text));
});
test("undo merge retains the complete live tail", async () => {
  writeFileSync(day(), row("original", "original row"));
  const [snap] = await snapshotFiles([day()]);
  const text = row("original", "original row") + row("large", "x".repeat(10000)) + row("tail", "keep this live row");
  await replaceWithCachedHandle(day(), text, row("original", "original row"));
  await restoreSnapshot(snap, root, "merge");
  expect(readFileSync(day(), "utf8")).toContain(row("tail", "keep this live row").trim());
  expect(readFileSync(day(), "utf8")).toContain(row("large", "x".repeat(10000)).trim());
});
test("unblocking one row conserves complete later block entries", async () => {
  const tail = `ts=tail reason="${"x".repeat(10000)}" blocked_at=now\n`;
  await replaceWithCachedHandle(blocklistFile(), `ts=remove reason=old blocked_at=now\n${tail}`);
  expect(await removeBlock("remove")).toBe(true);
  expect(readFileSync(blocklistFile(), "utf8")).toContain(tail.trim());
  expect(readFileSync(blocklistFile(), "utf8")).not.toContain("ts=remove");
});
test("ledger rotation keeps the newer half from the complete replacement", async () => {
  const lines = Array.from({length: 4}, (_, i) => `ts=${i} padding="${"x".repeat(700000)}"`);
  await replaceWithCachedHandle(hitsFile(), lines.join("\n") + "\n", " ".repeat(2000001));
  const memory = { ts: "new", type: "context", scope: "plan", content: "new row", file: "x", index: 0 } as Memory;
  expect(await recordHits("recall", "test", [memory])).toBe(true);
  const retained = readFileSync(hitsFile(), "utf8").trim().split("\n");
  expect(retained).toHaveLength(3);
  expect(retained.slice(0, 2)).toEqual(lines.slice(2));
});
test("import processes the final JSONL row rather than a cropped prefix", async () => {
  const file = join(root, "import.jsonl");
  const texts = ["x".repeat(10000), "last complete imported row"];
  await replaceWithCachedHandle(file, texts.map(content => JSON.stringify({type: "context", scope: "plan", content})).join("\n") + "\n");
  const seen: string[] = [];
  const tally = await importMemories(file, async c => { seen.push(c.content); return {action: "promoted"}; });
  expect(seen).toEqual(texts);
  expect(tally.promoted).toBe(2);
  expect(tally.skipped).toBe(0);
});
test("status parses the complete replacement JSON", async () => {
  const payload = { at: "now", block: "x".repeat(10000) };
  await replaceWithCachedHandle(statusFile(), JSON.stringify(payload));
  expect(await readStatus()).toMatchObject(payload);
});
test("missing callers preserve their distinct results", async () => {
  expect(await snapshotFiles([day()])).toEqual([]);
  expect(await removeBlock("missing")).toBe(false);
  expect(await readStatus()).toBeNull();
  await expect(importMemories(join(root, "missing.jsonl"), async () => ({action: "promoted"}))).rejects.toThrow("import file not found");
});

test("read failures propagate for store mutations while status stays fail-soft", async () => {
  mkdirSync(day());
  await expect(snapshotFiles([day()])).rejects.toMatchObject({code: "EISDIR"});
  mkdirSync(blocklistFile());
  await expect(removeBlock("missing")).rejects.toMatchObject({code: "EISDIR"});
  writeFileSync(statusFile(), "invalid JSON");
  expect(await readStatus()).toBeNull();
});
test("JSON readers retain BOM compatibility", async () => {
  writeFileSync(statusFile(), '\uFEFF{"at":"now","block":"complete"}');
  expect((await readStatus())?.block).toBe("complete");
  const path = join(root, "bom.jsonl");
  writeFileSync(path, '\uFEFF{"type":"context","scope":"plan","content":"complete"}\n');
  const seen: string[] = [];
  const tally = await importMemories(path, async c => { seen.push(c.content); return {action: "promoted"}; });
  expect(tally.promoted).toBe(1);
  expect(seen).toEqual(["complete"]);
});
