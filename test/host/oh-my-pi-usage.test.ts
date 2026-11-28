import { expect, test } from "bun:test";
import memory from "../../src/adapters/oh-my-pi/extension.ts";
import type {
  OmpContext,
  OmpTool,
} from "../../src/adapters/oh-my-pi/context.ts";
import { captureLagLines } from "../../src/status/metrics.ts";
import { summarizeHarnessActivity } from "../../src/status/harness-stats.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";
import { withTempStore } from "../helpers/temp-store.ts";

const store = withTempStore({ prefix: "osi-omp-usage-" });
const entry = (id: string, input: number, reasoningTokens?: number) => ({
  type: "message",
  id,
  message: {
    role: "assistant",
    content: [{ type: "text", text: "PRIVATE-TRANSCRIPT" }],
    usage: { input, cacheRead: 20, cacheWrite: 5, output: 30, reasoningTokens },
  },
});
async function driver(entries: unknown[], id = "stable-session") {
  const callbacks = new Map<string, (event: any, ctx: OmpContext) => unknown>();
  const tools = new Map<string, OmpTool>();
  const ctx = {
    cwd: store.root,
    sessionManager: { getSessionId: () => id, getEntries: () => entries },
  };
  await memory({
    on: (name, fn) => {
      callbacks.set(name, fn);
    },
    registerTool: (t) => {
      tools.set(t.name, t);
    },
  });
  const emit = (name: string, event = {}) => callbacks.get(name)?.(event, ctx);
  return {
    entries,
    emit,
    async report() {
      return (
        await tools
          .get("memory_status")!
          .execute("report", {}, undefined, undefined, ctx)
      ).content[0]!.text;
    },
    close: () => emit("session_shutdown"),
  };
}
async function stats() {
  return summarizeHarnessActivity(await captureLagLines(), []).harnesses.find(
    (g) => g.harness === "oh-my-pi",
  );
}

test("finalized session history replaces streaming and repeated events, preserving a reported reasoning split", async () => {
  const d = await driver([]);
  try {
    await d.emit("session_start");
    await d.emit("message_update", { message: entry("a", 999).message });
    expect((await stats())?.usage).toBeNull();
    await d.emit("before_agent_start", {
      reason: "prompt",
      prompt: "report usage",
      systemPrompt: [],
    });
    d.entries.push(entry("a", 100, 10), entry("b", 200, 5));
    await d.emit("agent_end");
    await d.emit("agent_end");
    expect((await stats())?.usage).toMatchObject({
      sessions: 1,
      input: 300,
      read: 40,
      write: 10,
      output: 45,
      reasoning: 15,
    });
    expect(await d.report()).toInclude("45 answer + 15 reasoning");
    expect(
      JSON.stringify(readEvidenceLog().filter((r) => r.ev === "session_usage")),
    ).not.toInclude("PRIVATE-TRANSCRIPT");
  } finally {
    await d.close();
  }
});

test("restart and transcript generation changes retain one accounting identity without reusing memory grounding", async () => {
  const history = [entry("a", 100)];
  const first = await driver(history);
  await first.emit("session_start");
  await first.close();
  const second = await driver(history);
  try {
    await second.emit("session_start");
    await second.emit("session_tree");
    await second.emit("session_clear");
    await second.emit("before_agent_start", {
      reason: "prompt",
      prompt: "report usage",
      systemPrompt: [],
    });
    history.push(entry("b", 200));
    await second.emit("agent_end");
    expect((await stats())?.usage).toMatchObject({
      sessions: 1,
      input: 300,
      output: 60,
      reasoning: null,
    });
    const report = await second.report();
    expect(report).toInclude("reasoning split not reported");
    expect(report).not.toInclude("60 answer + 0 reasoning");
    const receipts = readEvidenceLog().filter((r) => r.ev === "session_usage");
    expect(new Set(receipts.map((r) => r.session)).size).toBe(1);
  } finally {
    await second.close();
  }
});

test("cancelled and failed turns keep valid usage; malformed or non-assistant history cannot fabricate it", async () => {
  const d = await driver([
    {
      ...entry("aborted", 100, 10),
      message: { ...entry("aborted", 100, 10).message, stopReason: "aborted" },
    },
    {
      ...entry("error", 200, 5),
      message: { ...entry("error", 200, 5).message, stopReason: "error" },
    },
    {
      type: "message",
      message: { role: "user", usage: entry("user", 999).message.usage },
    },
    entry("bad", -1),
    entry("bad-split", 999, 40),
    { type: "model_usage", usage: entry("aux", 999).message.usage },
  ]);
  try {
    await d.emit("agent_end");
    expect((await stats())?.usage).toMatchObject({
      input: 300,
      output: 45,
      reasoning: 15,
    });
    await d.emit("agent_end");
    expect((await stats())?.usage?.input).toBe(300);
  } finally {
    await d.close();
  }
});

test("shutdown snapshots completed usage and ignores late notifications", async () => {
  const d = await driver([entry("done", 100)]);
  await d.close();
  d.entries.push(entry("late", 999));
  await d.emit("agent_end");
  expect((await stats())?.usage?.input).toBe(100);
});
