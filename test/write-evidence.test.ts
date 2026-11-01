// #163: promotion telemetry has a bounded reference window, while grounding
// and attribution keep the complete session ledger. Exercise the real tool
// entry point so a fix only in a test-built GateContext cannot pass.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDir } from "../src/core/config/paths.ts"
import { dateStr } from "../src/core/time.ts";
import { formatLine, parseLine } from "../src/core/logfmt/format.ts"
import { readLines } from "../src/core/logfmt/read.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { resetState, setCurrent } from "../src/core/state.ts";
import { blockedRecent } from "../src/status/write.ts";
import { afterTool, callsFor } from "../src/capture/triggers.ts";
import { startViewer } from "../src/viewer/server.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";

let root: string;
let loaded: LoadedPlugin;
let oldMemory: string | undefined;
let oldCommands: string | undefined;

beforeEach(async () => {
  oldMemory = process.env.OPENCODE_MEMORY_DIR;
  oldCommands = process.env.OPENCODE_COMMANDS_DIR;
  root = mkdtempSync(join(tmpdir(), "osi-write-evidence-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  const repo = join(root, "repo");
  mkdirSync(repo);
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  loaded = await loadPlugin(repo, { autoCapture: false });
});

afterEach(async () => {
  await loaded?.cleanup();
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  if (oldMemory === undefined) delete process.env.OPENCODE_MEMORY_DIR;
  else process.env.OPENCODE_MEMORY_DIR = oldMemory;
  if (oldCommands === undefined) delete process.env.OPENCODE_COMMANDS_DIR;
  else process.env.OPENCODE_COMMANDS_DIR = oldCommands;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function call(sid: string, id: string, tool = "read", command = "", exitCode = 0): Promise<void> {
  setCurrent({ sessionID: sid, callID: id, tool });
  await afterTool(
    { sessionID: sid, callID: id, tool, args: { command } },
    { output: exitCode ? "No matches found" : "content", metadata: { exitCode } },
  );
}

async function remember(sid: string, scope: string, status?: "open"): Promise<string> {
  setCurrent({ sessionID: sid, callID: `write-${scope}`, tool: "memory_remember" });
  return (await loaded.tools.memory_remember.execute(
    { type: "learning", scope, content: "The worker drains the queue before shutdown.", status },
    { sessionID: sid, callID: `write-${scope}` },
  )).content;
}

async function promoted(): Promise<{ line: string; refs: string[]; count: number }[]> {
  return (await readLines(join(evidenceDir(), `${dateStr()}.logfmt`)))
    .flatMap((line) => {
      const fields = parseLine(line);
      if (fields?.ev !== "write_promoted") return [];
      const list = String(fields.evidence_refs).slice(1, -1);
      return [{ line, refs: list ? list.split(",") : [], count: Number(fields.evidence_refs_count) }];
    });
}

test("1,000 and 2,000 calls produce bounded promotion lines with honest totals", async () => {
  for (let n = 0; n < 1000; n++) await call("long", `call_${String(n).padStart(20, "0")}`);
  expect(await remember("long", "first")).toStartWith("Remembered:");
  for (let n = 1000; n < 2000; n++) await call("long", `call_${String(n).padStart(20, "0")}`);
  expect(await remember("long", "later")).toStartWith("Remembered:");
  const rows = await promoted();
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(Buffer.byteLength(row.line)).toBeLessThan(2048);
    expect(row.refs.length).toBeLessThanOrEqual(16);
  }
  expect(rows.map((row) => row.count)).toEqual([1000, 2000]);
  expect(rows[0].refs).toContain("call_00000000000000000999");
  expect(rows[1].refs).toContain("call_00000000000000001999");
  // The first write has no existing day-file to snapshot; later writes do.
  // Normalize that unrelated path when comparing growth, after checking the
  // complete persisted lines against the byte budget above.
  const sizes = rows.map((row) => Buffer.byteLength(formatLine({ ...parseLine(row.line), snapshot: "-" })));
  expect(Math.abs(sizes[1] - sizes[0])).toBeLessThan(32);
  expect(callsFor("long")).toHaveLength(2000);
}, 30_000);

test("an old gate FAIL/edit/PASS and the latest gate check survive the recent window", async () => {
  await call("gate", "failed-gate", "bash", "vitest", 1);
  await call("gate", "fix-edit", "edit");
  await call("gate", "passed-gate", "bash", "vitest");
  await call("gate", "latest-check", "bash", "lint");
  for (let n = 0; n < 30; n++) await call("gate", `later-${n}`);
  expect(await remember("gate", "recovery")).toStartWith("Remembered:");
  const [row] = await promoted();
  for (const id of ["failed-gate", "fix-edit", "passed-gate", "latest-check", "later-29"]) {
    expect(row.refs).toContain(id);
  }
  expect(row.refs.length).toBeLessThanOrEqual(16);
  expect(new Set(row.refs).size).toBe(row.refs.length);
  expect(row.count).toBe(34);
});

test("tool retries and engagement remain auditable after non-code calls", async () => {
  await call("retry", "failed-search", "grep", "needle", 1);
  await call("retry", "fixed-search", "grep", "needle");
  for (let n = 0; n < 20; n++) await call("retry", `engaged-${n}`);
  for (let n = 0; n < 1000; n++) await call("retry", `other-${n}`, "memory_list");
  expect(await remember("retry", "retry")).toStartWith("Remembered:");
  const [row] = await promoted();
  for (const id of ["failed-search", "fixed-search", "engaged-19"]) expect(row.refs).toContain(id);
  expect(row.refs.length).toBeLessThanOrEqual(16);
  expect(row.count).toBe(1022);
  expect(parseLine(row.line)?.grounded_by).toBe("engagement");
});

test("another session cannot borrow grounding or refs; an empty planning session counts zero", async () => {
  await call("engaged", "private-call");
  for (let n = 0; n < 20; n++) await call("idle", `other-${n}`, "memory_list");
  expect(await remember("idle", "idle")).toContain("ambiguous_memory");
  expect(await remember("empty", "plan", "open")).toStartWith("Remembered:");
  const [row] = await promoted();
  expect(row.refs).toEqual([]);
  expect(row.count).toBe(0);
  expect((await blockedRecent()).map((row) => row.reason)).toContain("ambiguous_memory");
});

test("evidence, status, and viewer readers accept the bounded record unchanged", async () => {
  for (let n = 0; n < 20; n++) await call("readers", `read-${n}`);
  expect(await remember("readers", "readers")).toStartWith("Remembered:");
  expect(await remember("ungrounded", "blocked")).toContain("ambiguous_memory");
  const evidence = await loaded.tools.memory_evidence.execute({ ev: "write_promoted" }, { sessionID: "readers" });
  expect(evidence.content).toContain("evidence_refs_count=20");
  expect(evidence.content).toContain("read-19");
  const status = await loaded.tools.memory_status.execute({}, { sessionID: "readers" });
  expect(status.content).toContain("ambiguous_memory");
  const viewer = await startViewer(0);
  try {
    const response = await viewer.server.fetch(new Request(new URL("/api/data", viewer.url)));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].scope).toBe("readers");
  } finally {
    viewer.server.stop(true);
  }
});
