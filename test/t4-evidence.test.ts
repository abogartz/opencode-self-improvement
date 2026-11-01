import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { evidenceDir } from "../src/core/config/paths.ts"
import { dateStr } from "../src/core/time.ts";
import { parseLine } from "../src/core/logfmt/format.ts"
import { readLines } from "../src/core/logfmt/read.ts";
import { resetState, session, setCurrent } from "../src/core/state.ts";
import { afterTool, callsFor, writeEvidence } from "../src/capture/triggers.ts";

let root: string;
let old: string | undefined;
beforeEach(() => {
  old = process.env.OPENCODE_MEMORY_DIR;
  root = mkdtempSync(join(tmpdir(), "osi-t4-"));
  process.env.OPENCODE_MEMORY_DIR = root;
  resetState();
});
afterEach(() => {
  resetState();
  if (old === undefined) delete process.env.OPENCODE_MEMORY_DIR;
  else process.env.OPENCODE_MEMORY_DIR = old;
  if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("Unexpected fixture root");
  rmSync(root, { recursive: true, force: true });
});
async function call(id: string, tool = "read", command = "", exitCode = 0) {
  setCurrent({ sessionID: "t4", callID: id, tool });
  await afterTool({ sessionID: "t4", callID: id, tool, args: { command } },
    { output: "content", metadata: { exitCode } });
}
async function rows() {
  return (await readLines(join(evidenceDir(), `${dateStr()}.logfmt`)))
    .filter(line => parseLine(line)?.ev === "t4_learning")
    .map(line => ({ line, fields: parseLine(line)! }));
}
test("long recovery preserves old fix, chronological sample and full count", async () => {
  await call("failed", "bash", "vitest", 1);
  await call("old-edit", "edit");
  for (let i = 0; i < 400; i++) await call(`call_${String(i).padStart(20, "0")}`);
  expect(session("t4").pendingGate?.chain).toHaveLength(10);
  await call("passed", "bash", "vitest");
  const [row] = await rows();
  expect(Buffer.byteLength(row.line)).toBeLessThan(2048);
  expect(row.fields.evidence_chain_count).toBe("403");
  expect(row.fields.fix_ref).toBe("old-edit");
  expect(row.fields.evidence_chain).toBe(`[failed,old-edit,${Array.from({ length: 10 }, (_, i) => `call_${String(390 + i).padStart(20, "0")}`).join(",")},passed]`);
  expect(writeEvidence("t4").evidenceCalls.slice(0, 3)).toEqual(["failed", "old-edit", "passed"]);
  expect(callsFor("t4")).toHaveLength(403);
  expect(session("t4").pendingGate).toBeNull();
}, 30_000);
test("short chains retain all calls, latest write, and unrelated gate passes", async () => {
  await call("fail", "bash", "vitest", 1);
  await call("edit", "edit");
  await call("other", "bash", "lint");
  await call("write", "write");
  await call("pass", "bash", "vitest");
  const [row] = await rows();
  expect(row.fields.evidence_chain).toBe("[fail,edit,other,write,pass]");
  expect(row.fields.evidence_chain_count).toBe("5");
  expect(row.fields.fix_ref).toBe("write");
});
test("new failure replaces pending family and no edit falls back to PASS", async () => {
  await call("old", "bash", "vitest", 1);
  await call("old-fix", "edit");
  await call("new", "bash", "lint", 1);
  await call("unrelated", "bash", "vitest");
  expect(await rows()).toHaveLength(0);
  await call("pass", "bash", "lint");
  const [row] = await rows();
  expect(row.fields.evidence_chain).toBe("[new,unrelated,pass]");
  expect(row.fields.evidence_chain_count).toBe("3");
  expect(row.fields.fix_ref).toBe("pass");
});
