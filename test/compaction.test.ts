// Layer-1 hermetic test for the compaction contract.
//
// Why this exists: opencode's compaction path calls
//   plugin.trigger("experimental.session.compacting", {sessionID}, {context:[], prompt:undefined})
// and then feeds the SAME output object into the compaction model call
// (context is appended to the prompt, a set prompt replaces it). A plugin that
// pushes to `context` or sets `prompt` therefore changes the model call — the
// only way a well-behaved hook can "corrupt" compaction. This test pins the
// contract so a future hook refactor cannot silently start mutating it.
//
// Hermetic: OPENCODE_MEMORY_DIR points at a temp dir and the "live" source tree
// is a throwaway, so nothing here touches this repo or the real memory store.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dateStr, evidenceDir, memoryRoot } from "../src/config.ts";
import { formatLine, parseLine, type Fields } from "../src/logfmt.ts";
import { resetState } from "../src/state.ts";
import { loadPlugin } from "./harness.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-compact-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

type AnyHook = (input: unknown, output: unknown) => Promise<void>;

async function hooksFor(): Promise<Record<string, AnyHook | undefined>> {
  const loaded = await loadPlugin(liveRoot);
  return loaded as unknown as Record<string, AnyHook | undefined>;
}

function evidence(): Fields[] {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseLine(l))
    .filter((f): f is Fields => f !== null);
}

function field(line: Fields | undefined, key: string): string {
  return line ? String(line[key] ?? "") : "";
}

describe("compaction contract — the plugin must not corrupt the model call", () => {
  test("experimental.session.compacting leaves context/prompt untouched", async () => {
    const hooks = await hooksFor();
    const output: { context: string[]; prompt?: string } = { context: [], prompt: undefined };

    await hooks["experimental.session.compacting"]!({ sessionID: "ses_test" }, output);

    expect(output.context).toEqual([]);
    expect(output.prompt).toBeUndefined();
  });

  test("pre-existing compaction context/prompt are preserved (no clobber)", async () => {
    const hooks = await hooksFor();
    const output = { context: ["sentinel"], prompt: "REPLACEMENT" };

    await hooks["experimental.session.compacting"]!({ sessionID: "ses_test" }, output);

    expect(output.context).toEqual(["sentinel"]);
    expect(output.prompt).toBe("REPLACEMENT");
  });

  test("T2 evidence line is written as pure data (no chat)", async () => {
    const hooks = await hooksFor();
    await hooks["experimental.session.compacting"]!(
      { sessionID: "ses_test" },
      { context: [] },
    );

    const t2 = evidence().filter((l) => l.ev === "t2_compaction");
    expect(t2.length).toBe(1);
    expect(field(t2[0], "session")).toBe("ses_test");
    expect(field(t2[0], "captured_calls")).toBe("0");
    expect(field(t2[0], "pending_gate")).toBe("-");
    // evidence is DATA: no prompt/context fields ride along into the model call
    expect(field(t2[0], "context")).toBe("");
    expect(field(t2[0], "prompt")).toBe("");
  });

  test("tool results captured before compaction are counted in the T2 line", async () => {
    const hooks = await hooksFor();
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "ses_test", callID: "C1", args: { filePath: "x.ts" } },
      { title: "read", output: "content", metadata: {} },
    );

    await hooks["experimental.session.compacting"]!(
      { sessionID: "ses_test" },
      { context: [] },
    );

    const t2 = evidence().filter((l) => l.ev === "t2_compaction");
    expect(t2.length).toBe(1);
    expect(field(t2[0], "captured_calls")).toBe("1");
  });
});

describe("compaction-time hook surface is total (never throws)", () => {
  test("experimental.chat.system.transform tolerates the compaction request shape", async () => {
    const hooks = await hooksFor();
    const output = { system: [] as string[] };

    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "ses_test", model: {} },
      output,
    );

    // empty store -> no digest; and no evidence text leaks into the system prompt
    expect(output.system).toEqual([]);
  });

  test("tool.execute.after tolerates unknown/degenerate tools", async () => {
    const hooks = await hooksFor();
    await hooks["tool.execute.after"]!(
      { tool: "unknown-tool", sessionID: "ses_test", callID: "C2", args: {} },
      { title: "", output: "", metadata: {} },
    );

    expect(evidence().some((l) => l.ev === "t2_compaction")).toBe(false);
  });

  test("the plugin registers no messages.transform/autocontinue hook", async () => {
    const hooks = await hooksFor();
    expect(hooks["experimental.chat.messages.transform"]).toBeUndefined();
    expect(hooks["experimental.compaction.autocontinue"]).toBeUndefined();
  });
});

// --- memory-aware compaction anchor ------------------------------------------
// The hook pushes a durable-memory block onto the V2 compaction event's
// `system` parts (visible to the summarizer model). The harness adapter copies
// pushed part texts onto `output.system`.

function seed(status: "open" | "settled" | undefined, type: string, scope: string, content: string): void {
  const file = join(memoryRoot(), `${new Date().toISOString().split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, formatLine({ ts: new Date().toISOString(), type, scope, content, status }) + "\n");
}

describe("memory-aware compaction anchor", () => {
  test("open + settled memories are pushed as a system part the summarizer sees", async () => {
    seed("open", "context", "plan", "Open thread: finish the flurb widget migration before Friday.");
    seed(undefined, "pattern", "build", "Build the widget with make all and test it with bun test.");

    const hooks = await hooksFor();
    const output = {
      context: [] as string[],
      prompt: undefined as string | undefined,
      system: [] as string[],
    };
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_anchor" }, output);

    expect(output.system.length).toBe(1);
    const anchor = output.system[0];
    expect(anchor.toLowerCase()).toContain("preserve");
    expect(anchor).toContain("flurb widget migration"); // open thread content
    expect(anchor).toContain("make all"); // settled content
    // The V1 contract still holds: the plugin never touches context/prompt.
    expect(output.context).toEqual([]);
    expect(output.prompt).toBeUndefined();
  });

  test("no active memories -> no anchor pushed; T2 bookkeeping still runs", async () => {
    const hooks = await hooksFor();
    const output = { context: [] as string[], system: [] as string[] };
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_anchor_empty" }, output);

    expect(output.system).toEqual([]);
    const t2 = evidence().filter((l) => l.ev === "t2_compaction");
    expect(t2.length).toBe(1);
    expect(field(t2[0], "session")).toBe("ses_anchor_empty");
  });

  test("anchor is capped at 2500 chars and never cut mid-line", async () => {
    for (let i = 0; i < 40; i++) {
      seed(i % 2 === 0 ? "open" : "settled", "learning", "bench",
        `flurb benchmark note ${i}: ` + "x".repeat(200));
    }
    const hooks = await hooksFor();
    const output = { context: [] as string[], system: [] as string[] };
    await hooks["experimental.session.compacting"]!({ sessionID: "ses_anchor_cap" }, output);

    expect(output.system.length).toBe(1);
    const anchor = output.system[0];
    expect(anchor.length).toBeGreaterThan(0);
    expect(anchor.length).toBeLessThanOrEqual(2500);
    for (const line of anchor.split("\n")) {
      expect(["##", "Pr", "- "].some((p) => line.startsWith(p))).toBe(true);
    }
  });
});
