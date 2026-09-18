// Open-thread (frontier) behavior: status storage, gate promotion for
// status="open", the planning hint on ambiguous blocks, frontier injection in
// the system digest, the open-first tie-break, and the frontier_injected
// evidence line. Hermetic: temp OPENCODE_MEMORY_DIR, throwaway live tree.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dateStr, evidenceDir, memoryRoot } from "../src/config.ts";
import { parseLine, type Fields } from "../src/logfmt.ts";
import { appendMemory, loadAll } from "../src/memory.ts";
import { runWriteGate, type GateContext } from "../src/gates.ts";
import { relevantKnowledge, systemDigest } from "../src/inject.ts";
import { resetState, setCurrent } from "../src/state.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-frontier-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
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

function ctx(): GateContext {
  return { liveRoot, evidenceCalls: [], hasGateCheck: false };
}

async function seedOpen(scope: string, content: string, type = "context"): Promise<string> {
  return appendMemory({ type, scope, content, status: "open" });
}

describe("open-thread storage (status field)", () => {
  test("status=open survives the write gate and round-trips from disk", async () => {
    const out = await runWriteGate(
      {
        type: "context",
        scope: "poc",
        content: "frontier: prove the planning loop end to end",
        status: "open",
      },
      ctx(),
    );
    expect(out.action).toBe("promoted");

    const stored = (await loadAll()).find((m) => m.scope === "poc");
    expect(stored?.status).toBe("open");
    expect(stored?.content).toContain("prove the planning loop");

    const wp = evidence().find((l) => l.ev === "write_promoted");
    expect(wp && String(wp.status)).toBe("open");
  });

  test("status=open alone (no refs, no gate check) now promotes — the ambiguity-lift fix", async () => {
    const out = await runWriteGate(
      {
        type: "decision",
        scope: "poc",
        content: "decided: surface the frontier, reject skills bloat",
        status: "open",
      },
      ctx(),
    );
    expect(out.action).toBe("promoted");
    expect(evidence().some((l) => l.ev === "write_blocked")).toBe(false);
  });

  test("settled (or omitted) still requires grounding — status does not open a second door", async () => {
    const out = await runWriteGate(
      {
        type: "learning",
        scope: "poc",
        content: "tests pass now",
        status: "settled",
      },
      ctx(),
    );
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("ambiguous_memory");
  });

  test("open with empty scope is still ambiguous (no home without a scope)", async () => {
    const out = await runWriteGate(
      { type: "context", scope: "", content: "todo: fix the loop", status: "open" },
      ctx(),
    );
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("ambiguous_memory");
  });
});

describe("planning hint on ambiguous blocks", () => {
  test("planning-flavored ambiguous write gets a status=open hint", async () => {
    const out = await runWriteGate(
      {
        type: "context",
        scope: "poc",
        content: "plan the next frontier for auth: reject JWT, open options",
      },
      ctx(),
    );
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("ambiguous_memory");
    expect(out.hint).toContain('status="open"');
  });

  test("non-planning ambiguous write gets no hint", async () => {
    const out = await runWriteGate(
      { type: "learning", scope: "poc", content: "tests pass now" },
      ctx(),
    );
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("ambiguous_memory");
    expect(out.hint).toBeUndefined();
  });
});

describe("frontier injection (systemDigest)", () => {
  test("open threads surface as a capped frontier block", async () => {
    await seedOpen("poc", "build feature X; reject skills bank; open decision on scoring");
    const system: string[] = [];
    await systemDigest({ sessionID: "sess-f1" }, { system });
    const digest = system.join("\n");
    expect(digest).toContain("## Open threads (frontier)");
    expect(digest).toContain("reject skills bank");
    expect(digest).toContain("[open]");
  });

  test("no open threads -> digest stays two-line tiny", async () => {
    await appendMemory({ type: "pattern", scope: "poc", content: "run the suite with vitest" });
    const system: string[] = [];
    await systemDigest({}, { system });
    const digest = system.join("\n");
    expect(digest).not.toContain("Open threads");
    expect(digest.split("\n").filter((l) => l.trim()).length).toBeLessThanOrEqual(3);
  });

  test("only the newest open threads are shown (capped)", async () => {
    await seedOpen("poc", "thread one rejected, marked stale");
    await seedOpen("poc", "thread two resolved, closed");
    await seedOpen("poc", "thread three is the live frontier");
    await seedOpen("poc", "thread four newest candidate");
    const system: string[] = [];
    await systemDigest({}, { system });
    const digest = system.join("\n");
    expect(digest).toContain("thread four newest candidate");
    expect(digest).toContain("thread three is the live frontier");
    expect(digest).not.toContain("thread one rejected");
  });

  test("frontier_injected evidence recorded per session with scopes", async () => {
    await seedOpen("poc", "frontier: prove the planning loop end to end");
    const system: string[] = [];
    await systemDigest({ sessionID: "sess-f2" }, { system });
    const lines = evidence().filter((l) => l.ev === "frontier_injected");
    expect(lines.length).toBe(1);
    expect(String(lines[0].scopes)).toContain("poc");
    expect(String(lines[0].shown)).toBe("1");
  });
});

describe("open-first tie-break in scoreMemories", () => {
  test("equal-scoring memories rank the open thread first", async () => {
    await appendMemory({ type: "context", scope: "poc", content: "next frontier plan for scoring" });
    await seedOpen("poc", "next frontier plan for scoring");
    const block = await relevantKnowledge("next frontier plan", 3);
    const openIdx = block.indexOf("[open]");
    const settledIdx = block.indexOf("- [", block.indexOf("[open]") + 1);
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(settledIdx).toBeGreaterThan(openIdx);
  });
});