// Behavior-grounded gate injection (frontier OPEN item) + hook-robustness.
// Contract: in-session code engagement (grep/glob/read/edit/write/bash results)
// is admissible GATE-4 grounding for a settled claim — the write records
// behavior that actually happened, so hand-copied refs are redundant. The
// other guardrails stay: empty scope blocks, drift/stale refs block,
// no-engagement sessions still require refs/open-status/gate-check/canonical.
// Robustness: every host hook fails closed so a corrupt/missing store can never
// break a tool call or the system transform.
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
import { formatLine, parseLine, readLines, type Fields } from "../src/logfmt.ts";
import { appendMemory, isActive, loadAll } from "../src/memory.ts";
import { runWriteGate, type GateContext } from "../src/gates.ts";
import { afterTool, evidenceCalls, hasEngagement, hasGateCheck } from "../src/triggers.ts";
import { systemDigest } from "../src/inject.ts";
import { resetState, setCurrent } from "../src/state.ts";
import { SelfImprovement } from "../index.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-ge-"));
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

function ctx(sid: string): GateContext {
  return {
    liveRoot,
    evidenceCalls: evidenceCalls(sid),
    hasGateCheck: hasGateCheck(sid),
    hasEngagement: hasEngagement(sid),
  };
}

async function engage(sid: string, calls: [string, string, Record<string, unknown>][]): Promise<void> {
  for (const [callID, tool, args] of calls) {
    setCurrent({ sessionID: sid, callID, tool });
    const out = tool === "grep" ? "3 matches found" : tool === "bash" ? "ok" : "content";
    await afterTool({ tool, sessionID: sid, callID, args }, { output: out, metadata: {} });
  }
}

describe("gate injection — engagement grounds settled claims", () => {
  test("grep+read engagement (no gate check, no refs) promotes; gate_injected evidence + grounded_by", async () => {
    const sid = "ge-promote";
    await engage(sid, [
      ["C1", "grep", { pattern: "logger" }],
      ["C2", "read", { filePath: "engine.ts" }],
    ]);

    setCurrent({ sessionID: sid, callID: "C3", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "learning", scope: "engine", content: "engine uses the clp logger, not winston" },
      ctx(sid),
    );
    expect(outcome.action).toBe("promoted");

    const lines = evidence();
    const gi = ev(lines, "gate_injected")[0];
    expect(gi).toBeTruthy();
    expect(field(gi, "gate")).toBe("4");
    const wp = ev(lines, "write_promoted")[0];
    expect(field(wp, "grounded_by")).toBe("engagement");
    expect(ev(lines, "write_blocked").length).toBe(0);
  });

  test("control: the SAME write without engagement is blocked ambiguous", async () => {
    const sid = "ge-block" ;
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "learning", scope: "engine", content: "engine uses the clp logger, not winston" },
      ctx(sid),
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("ambiguous_memory");
    expect(ev(evidence(), "gate_injected").length).toBe(0);
  });

  test("empty scope stays ambiguous even when engaged", async () => {
    const sid = "ge-scope";
    await engage(sid, [["C1", "read", { filePath: "engine.ts" }]]);

    setCurrent({ sessionID: sid, callID: "C2", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "learning", scope: "", content: "the lock is engagement" },
      ctx(sid),
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("ambiguous_memory");
    expect(field(ev(evidence(), "write_blocked")[0], "flags")).toContain("empty_scope");
  });

  test("engagement does NOT bypass the stale-ref poisoning guard (GATE-1)", async () => {
    writeFileSync(
      join(liveRoot, "table_manager.ts"),
      "export function save(config, opts) {\n  return [config, opts];\n}\n",
    );
    await appendMemory({
      type: "pattern",
      scope: "ctl",
      content: "use table_manager.save(opts)",
    });
    const sid = "ge-stale";
    await engage(sid, [
      ["C1", "grep", { pattern: "save" }],
      ["C2", "read", { filePath: "table_manager.ts" }],
      ["C3", "edit", { filePath: "table_manager.ts" }],
    ]);

    setCurrent({ sessionID: sid, callID: "C4", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "pattern", scope: "ctl", content: "use table_manager.save(opts)" },
      ctx(sid),
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("drift_ref_stale_incoming");
    expect(ev(evidence(), "write_promoted").length).toBe(0);
  });
});

describe("gate injection — real plugin tool path", () => {
  test("an engaged session persists a settled fact through memory_remember (full wiring)", async () => {
    const hooks = await SelfImprovement({ directory: liveRoot } as never) as unknown as {
      tool: Record<string, { execute(args: unknown): Promise<string> }>;
      "tool.execute.before": (i: unknown) => Promise<void>;
      "tool.execute.after": (i: unknown, o: unknown) => Promise<void>;
    };

    await hooks["tool.execute.after"]!(
      { tool: "grep", sessionID: "ge-full", callID: "C1", args: { pattern: "logger" } },
      { output: "2 matches found", metadata: {} },
    );
    await hooks["tool.execute.before"]!({
      sessionID: "ge-full",
      callID: "C2",
      tool: "memory_remember",
      args: {},
    });
    const res = await hooks.tool.memory_remember.execute({
      type: "learning",
      scope: "engine",
      content: "engine uses the clp logger",
    });
    expect(res).toContain("Remembered");

    const mems = (await loadAll()).filter(isActive);
    expect(mems.some((m) => m.content.includes("clp logger"))).toBe(true);
    expect(field(ev(evidence(), "write_promoted")[0], "grounded_by")).toBe("engagement");
  });
});

describe("hook robustness — fail closed on a corrupt store", () => {
  test("hooks resolve (never throw) when OPENCODE_MEMORY_DIR is a file, not a dir", async () => {
    const badRoot = join(root, "memory");
    writeFileSync(badRoot, "not a directory");
    process.env.OPENCODE_MEMORY_DIR = badRoot;

    const hooks = await SelfImprovement({ directory: liveRoot } as never) as unknown as {
      "experimental.chat.system.transform": (i: unknown, o: unknown) => Promise<void>;
      "tool.execute.after": (i: unknown, o: unknown) => Promise<void>;
      "experimental.session.compacting": (i: unknown, o: unknown) => Promise<void>;
      "tool.execute.before": (i: unknown) => Promise<void>;
    };

    const system = { system: [] as string[] };
    await expect(
      hooks["experimental.chat.system.transform"]!({ sessionID: "s" }, system),
    ).resolves.toBeUndefined();
    expect(system.system).toEqual([]);

    await expect(
      hooks["tool.execute.after"]!(
        { tool: "grep", sessionID: "s", callID: "C1", args: { pattern: "x" } },
        { output: "2 matches found", metadata: {} },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks["experimental.session.compacting"]!({ sessionID: "s" }, { context: [] }),
    ).resolves.toBeUndefined();
  });

  test("the digest still reaches the hook surface when the store is healthy (guards actually run)", async () => {
    const hooks = await SelfImprovement({ directory: liveRoot } as never) as unknown as {
      "experimental.chat.system.transform": (i: unknown, o: unknown) => Promise<void>;
    };
    await appendMemory({ type: "pattern", scope: "engine", content: "run the engine tests with vitest" });

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: "ge-digest" }, output);
    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("## Persistent memory");
    expect(output.system[0]).not.toContain("ev=");
  });
});

describe("hasEngagement signal", () => {
  test("false for a session that only used memory tools; true after any code tool", async () => {
    const sid = "ge-signal";

    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_recall" });
    await afterTool({ tool: "memory_recall", sessionID: sid, callID: "C1", args: {} }, { output: "none", metadata: {} });
    expect(hasEngagement(sid)).toBe(false);

    setCurrent({ sessionID: sid, callID: "C2", tool: "read" });
    await afterTool({ tool: "read", sessionID: sid, callID: "C2", args: { filePath: "x.ts" } }, { output: "content", metadata: {} });
    expect(hasEngagement(sid)).toBe(true);
  });
});

describe("store robustness — malformed evidence and cross-session writes", () => {
  test("garbage evidence lines never break the convergence aggregate", async () => {
    const sid = "ge-robust";
    mkdirSync(evidenceDir(), { recursive: true });
    writeFileSync(
      join(evidenceDir(), `${dateStr()}.logfmt`),
      [
        "THIS IS NOT LO GFMT AT ALL",
        "# just a comment line",
        'ev="session_convergence" ts=2026-09-18T20:40:39Z session=conv-ok turns=4 turns_to_tap=1',
        "ev=session_convergence session=conv-broken turns_to_tap=banana", // non-numeric tap
        "garbage=   unclosed quotes",
        "{}",
        "ev= ",
      ].join("\n") + "\n",
    );
    // Clobber the current-session store with noise too, then roll a real tap.
    const { recentConvergenceSummary } = await import("../src/triggers.ts");
    const summary = await recentConvergenceSummary(6);
    expect(summary).toContain("2 sessions tracked");
    expect(summary).toContain("1 reached the frontier");
    // I3: raw evidence never surfaces.
    expect(summary).not.toContain("ev=");
  });

  test("a second session writing the identical settled fact is a canonical/duplicate collapse, not a new row", async () => {
    const sidA = "ge-xa";
    await engage(sidA, [["C1", "grep", { pattern: "logger" }]]);
    setCurrent({ sessionID: sidA, callID: "C2", tool: "memory_remember" });
    const first = await runWriteGate(
      { type: "decision", scope: "dupe", content: "use the internal logger for app tracing" },
      ctx(sidA),
    );
    expect(first.action).toBe("promoted");

    // A brand-new session (fresh state) proposes the identical fact.
    const sidB = "ge-xb";
    resetState();
    await engage(sidB, [["C1", "read", { filePath: "logging.ts" }]]);
    setCurrent({ sessionID: sidB, callID: "C2", tool: "memory_remember" });
    const second = await runWriteGate(
      { type: "decision", scope: "dupe", content: "use the internal logger for app tracing" },
      ctx(sidB),
    );
    expect(second.action).toBe("collapsed");
    const durable = await loadAll();
    expect(durable.filter((m) => m.scope === "dupe" && isActive(m)).length).toBe(1);
  });
});