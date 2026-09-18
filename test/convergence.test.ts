// Time-to-frontier (session convergence) measurement. Contract: deterministic
// signals only — completed-message turns, the FIRST memory_recall that surfaced
// an open thread, and grep/glob/read re-derivation — rolled up per session into
// a `session_convergence` evidence line at compaction (or when a newer session
// opens), plus a one-line aggregate in the frontier digest block. Evidence is
// data (I3): nothing raw leaks into chat.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dateStr, evidenceDir, memoryRoot } from "../src/config.ts";
import { formatLine, parseLine, type Fields } from "../src/logfmt.ts";
import { appendMemory } from "../src/memory.ts";
import { systemDigest } from "../src/inject.ts";
import {
  checkNewSession,
  finalizeSession,
  firstFrontierTap,
  markFrontierTap,
  markTurn,
  onCompacting,
  recentConvergenceSummary,
} from "../src/triggers.ts";
import { resetState, setCurrent } from "../src/state.ts";
import { SelfImprovement } from "../index.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-conv-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
});

function evidence(): Fields[] {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseLine(l))
    .filter((f): f is Fields => f !== null);
}

function ev(lines: Fields[], name: string): Fields[] {
  return lines.filter((l) => l.ev === name);
}

function field(line: Fields | undefined, key: string): string {
  return line ? String(line[key] ?? "") : "";
}

async function engage(sid: string, callID: string, tool: string): Promise<void> {
  setCurrent({ sessionID: sid, callID, tool });
  const { afterTool } = await import("../src/triggers.ts");
  await afterTool(
    { tool, sessionID: sid, callID, args: tool === "grep" ? { pattern: "x" } : { filePath: "x.ts" } },
    { output: tool === "grep" ? "3 matches found" : "content", metadata: {} },
  );
}

describe("session rollup (session_convergence evidence)", () => {
  test("a tapped session rolls up turns / tap point / re-derivation / wall time", async () => {
    const sid = "conv-tap";
    markTurn(sid); // turn 1
    markTurn(sid); // turn 2
    await engage(sid, "C1", "grep");
    await engage(sid, "C2", "read");
    markFrontierTap(sid, "C3");

    setCurrent({ sessionID: sid, callID: "C4", tool: "memory_too" });
    await onCompacting({ sessionID: sid });

    const lines = evidence();
    const c = ev(lines, "session_convergence")[0];
    expect(c).toBeTruthy();
    expect(field(c, "session")).toBe(sid);
    expect(field(c, "turns")).toBe("2");
    expect(field(c, "tap_at")).toBe("C3");
    expect(field(c, "turns_to_tap")).toBe("2");
    expect(field(c, "re_derives")).toBe("2");
    expect(field(c, "calls")).toBe("2");
    expect(Number(field(c, "ms_to_tap"))).toBeGreaterThanOrEqual(0);

    // Idempotent: a second compaction does not double the rollup.
    await onCompacting({ sessionID: sid });
    expect(ev(evidence(), "session_convergence").length).toBe(1);
  });

  test("a session that never taps still rolls up with '-' markers", async () => {
    const sid = "conv-notap";
    markTurn(sid);
    await engage(sid, "C1", "glob");

    await finalizeSession(sid);
    const c = ev(evidence(), "session_convergence")[0];
    expect(field(c, "session")).toBe(sid);
    expect(field(c, "tap_at")).toBe("-");
    expect(field(c, "turns_to_tap")).toBe("");
    expect(field(c, "ms_to_tap")).toBe("");
    expect(field(c, "re_derives")).toBe("1");
  });

  test("opening a newer session finalizes the previous one (no session-end hook)", async () => {
    const a = "conv-a";
    await checkNewSession(a); // first message of session A registers it
    markTurn(a);
    await engage(a, "C1", "read");

    await checkNewSession("conv-b"); // session B opens -> A closes
    const c = ev(evidence(), "session_convergence").find((l) => String(l.session) === a);
    expect(c).toBeTruthy();
    expect(field(c, "tap_at")).toBe("-");
  });

  test("a tap AFTER compaction still counts in the aggregate (late-tap race)", async () => {
    // Real-world race (2026-09-18 20:40/20:44 UTC): compaction finalized the
    // rollup BEFORE the session's first recall surfaced an open thread. The
    // rollup says tap_at=- but the session DID reach the frontier — the
    // frontier_tapped evidence must merge back into the aggregate.
    const sid = "conv-late-tap";
    await appendMemory({
      type: "context",
      scope: "poc",
      content: "frontier: late-tap race",
      status: "open",
    });
    const hooks = await SelfImprovement({ directory: liveRoot } as never) as unknown as {
      tool: Record<string, { execute(args: unknown): Promise<string> }>;
    };
    markTurn(sid); // turn 1
    await engage(sid, "C1", "read");
    setCurrent({ sessionID: sid, callID: "C2", tool: "memory_compact" });
    await onCompacting({ sessionID: sid }); // finalizes WITHOUT a tap
    expect(field(ev(evidence(), "session_convergence")[0], "tap_at")).toBe("-");
    expect(field(ev(evidence(), "session_convergence")[0], "turns_to_tap")).toBe("");

    // The session keeps going, then recalls the open thread -> late tap.
    markTurn(sid); // turn 2
    setCurrent({ sessionID: sid, callID: "C3", tool: "memory_recall" });
    await hooks.tool.memory_recall.execute({ scope: "poc", limit: 10 });
    const t = ev(evidence(), "frontier_tapped")[0];
    expect(t).toBeTruthy();
    expect(field(t, "turn")).toBe("2");

    // The rollup stays pristine (append-only, no double count)…
    expect(field(ev(evidence(), "session_convergence")[0], "turns_to_tap")).toBe("");
    expect(ev(evidence(), "session_convergence").length).toBe(1);
    // …but the aggregate now counts this session as having reached the frontier.
    const summary = await recentConvergenceSummary(6);
    expect(summary).toContain("1 sessions tracked");
    expect(summary).toContain("1 reached the frontier");
  });

  test("silent sessions emit no rollup", async () => {
    await finalizeSession("conv-silent");
    expect(ev(evidence(), "session_convergence").length).toBe(0);
  });
});

describe("measurement through the real plugin surface", () => {
  test("memory_recall that surfaces an open thread records a frontier tap", async () => {
    const sid = "conv-real";
    await appendMemory({
      type: "context",
      scope: "poc",
      content: "frontier: prove convergence measurement",
      status: "open",
    });
    const hooks = await SelfImprovement({ directory: liveRoot } as never) as unknown as {
      tool: Record<string, { execute(args: unknown): Promise<string> }>;
    };
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_recall" });
    markTurn(sid);

    const res = await hooks.tool.memory_recall.execute({ limit: 10 });
    expect(res).toContain("[open]");

    const t = ev(evidence(), "frontier_tapped")[0];
    expect(t).toBeTruthy();
    expect(field(t, "n_open")).toBe("1");
    expect(firstFrontierTap(sid)?.call).toBe("C1");
    expect(firstFrontierTap(sid)?.turn).toBe(1);
    await finalizeSession(sid);
    expect(field(ev(evidence(), "session_convergence")[0], "turns_to_tap")).toBe("1");
  });

  test("memory_recall with no open threads does not mark a tap", async () => {
    const sid = "conv-norecall";
    await appendMemory({ type: "pattern", scope: "poc", content: "run tests with vitest" });
    const hooks = await SelfImprovement({ directory: liveRoot } as never) as unknown as {
      tool: Record<string, { execute(args: unknown): Promise<string> }>;
    };
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_recall" });

    await hooks.tool.memory_recall.execute({ limit: 10 });
    expect(ev(evidence(), "frontier_tapped").length).toBe(0);
    expect(firstFrontierTap(sid)).toBeUndefined();
  });
});

describe("digest aggregate (convergence tracking)", () => {
  test("a one-line aggregate rides the frontier block when prior sessions exist", async () => {
    await appendMemory({
      type: "context",
      scope: "poc",
      content: "frontier: prove convergence measurement",
      status: "open",
    });
    mkdirSync(evidenceDir(), { recursive: true });
    writeFileSync(
      join(evidenceDir(), `${dateStr()}.logfmt`),
      formatLine({ ev: "session_convergence", ts: "t1", session: "s1", turns: "5", turns_to_tap: "2" }) + "\n" +
      formatLine({ ev: "session_convergence", ts: "t2", session: "s2", turns: "8", turns_to_tap: "3" }) + "\n",
    );

    const system: string[] = [];
    await systemDigest({ sessionID: "conv-digest" }, { system });
    const digest = system.join("\n");
    expect(digest).toContain("## Open threads (frontier)");
    expect(digest).toContain("Convergence tracking:");
    expect(digest).toContain("2 sessions tracked");
    expect(digest).toContain("first tap ~2.5 turns");
    // I3: derived fact only — no raw evidence/logfmt names in chat.
    expect(digest).not.toContain("ev=session_convergence");
  });

  test("no measurement yet -> no convergence line", async () => {
    await appendMemory({
      type: "context",
      scope: "poc",
      content: "frontier: prove convergence measurement",
      status: "open",
    });
    const system: string[] = [];
    await systemDigest({}, { system });
    expect(system.join("\n")).not.toContain("Convergence tracking");
  });

  test("recentConvergenceSummary is empty on a fresh store", async () => {
    expect(await recentConvergenceSummary()).toBe("");
  });
});