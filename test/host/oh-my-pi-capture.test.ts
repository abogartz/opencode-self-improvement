import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { decodeTranscript } from "../../src/adapters/oh-my-pi/transcript.ts";
import {
  createOhMyPiCapture,
  type OmpCaptureBinding,
} from "../../src/adapters/oh-my-pi/capture.ts";
import { createOhMyPiMemory } from "../../src/adapters/oh-my-pi/extension.ts";
import type {
  OmpContext,
  OmpEvents,
  OmpTool,
} from "../../src/adapters/oh-my-pi/context.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { normalizeDirPath } from "../../src/identity/repokey.ts";
import { withTempStore } from "../helpers/temp-store.ts";

const store = withTempStore({ prefix: "osi-omp-capture-" });
const FACT = "The nightly archive job keeps fourteen days of tarballs.";
const ANSWER = JSON.stringify([
  { type: "context", scope: "batch", content: FACT, status: "settled" },
]);

test("overlapping compaction bindings preserve each operation's model and transcript after awaits", async () => {
  const capture = createOhMyPiCapture();
  const release = Promise.withResolvers<void>();
  const run = (id: string) =>
    capture.withBinding(
      id,
      {
        messages: [{ role: "user", content: id }],
        model: { providerID: id, id: "model" },
        generateText: async () => id,
      },
      async () => {
        await release.promise;
        expect(await capture.host.readTranscript!(id)).toEqual([
          { role: "user", text: id },
        ]);
        const model = (await capture.host.defaultModel!(id))!;
        expect(model.providerID).toBe(id);
        return capture.host.generateText!({
          sessionID: id,
          model,
          prompt: "capture",
          signal: new AbortController().signal,
        });
      },
    );
  const first = run("first");
  const second = run("second");
  release.resolve();
  expect(await Promise.all([first, second])).toEqual(["first", "second"]);
  expect(await capture.host.defaultModel!("first")).toBeNull();
});
function binding(
  generateText: OmpCaptureBinding["generateText"] = async () => ANSWER,
): OmpCaptureBinding {
  return {
    messages: [
      {
        role: "user",
        content:
          "We finished the archive change. Remember that the nightly archive job keeps fourteen days of tarballs. The batch importer respects the staging rate limit per key, which matters while wiring the importer tooling.",
      },
      {
        role: "assistant",
        content:
          "The archive policy has been verified and the importer will respect the staging limit.",
      },
    ],
    model: { providerID: "fixture", id: "capture" },
    generateText,
  };
}

async function driver(
  capture: (ctx: OmpContext) => OmpCaptureBinding | undefined,
  options = {},
) {
  const handlers = new Map<string, (event: any, ctx: OmpContext) => unknown>();
  const tools = new Map<string, OmpTool>();
  await createOhMyPiMemory({ capture, options })({
    on: (name, handler) => {
      handlers.set(name, handler);
    },
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
  });
  let ctx: OmpContext = {
    cwd: store.root,
    sessionManager: { getSessionId: () => "session" },
  };
  const emit = async <K extends keyof OmpEvents>(
    name: K,
    event: OmpEvents[K],
  ) => handlers.get(name)?.(event, ctx);
  return {
    emit,
    async move(cwd: string) {
      ctx = { cwd, sessionManager: { getSessionId: () => "session" } };
      await emit("session_switch", {});
    },
    ground: () =>
      emit("tool_result", {
        toolName: "read",
        toolCallId: "read",
        input: {},
        content: [{ type: "text", text: FACT }],
        isError: false,
      }),
    recall: async () =>
      (
        await tools
          .get("memory_recall")!
          .execute(
            "recall",
            { query: "nightly archive tarballs" },
            undefined,
            undefined,
            ctx,
          )
      ).content
        .map((p) => p.text)
        .join("\n"),
    close: () => emit("session_shutdown", {}),
  };
}

test("transcripts retain cursor slots but exclude reasoning, tools, and agent-authored user messages", () => {
  const decoded = decodeTranscript([
    {
      role: "user",
      content: "Real preference",
      attribution: "user",
      timestamp: 123,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private", text: "private" },
        { type: "text", text: "Public answer" },
      ],
    },
    { role: "user", attribution: "agent", content: "Forged user preference" },
    { role: "toolResult", content: [{ type: "text", text: "Tool data" }] },
    { role: "custom", attribution: "user", content: "Synthetic instruction" },
    null,
  ]);
  expect(decoded).toEqual([
    { role: "user", text: "Real preference", timestamp: 123 },
    { role: "assistant", text: "Public answer" },
    { text: "" },
    { text: "" },
    { text: "" },
    { text: "" },
  ]);
});

test("queued captures retain their transcript and model snapshots across interleaving", async () => {
  const capture = createOhMyPiCapture();
  const stop = new AbortController();
  const iterator = capture.host.turnEndEvents!(stop.signal)[
    Symbol.asyncIterator
  ]();
  const next = iterator.next();
  const messages = [{ role: "user", content: "original" }];
  const model = { providerID: "fixture", id: "first" };
  const first = capture.publish("session", {
    messages,
    model,
    generateText: async () => "first answer",
  });
  messages[0].content = "mutated";
  model.id = "changed";
  expect((await next).value).toEqual({ sessionID: "session" });
  const second = capture.publish("other", {
    messages: [],
    model: { providerID: "fixture", id: "second" },
    generateText: async () => "second answer",
  });
  expect(await capture.host.readTranscript!("session")).toEqual([
    { role: "user", text: "original" },
  ]);
  expect(capture.host.defaultModel!("session")).toEqual({
    providerID: "fixture",
    id: "first",
  });
  expect(
    await capture.host.generateText!({
      sessionID: "session",
      model: { providerID: "fixture", id: "first" },
      prompt: "clean",
      signal: stop.signal,
    }),
  ).toBe("first answer");
  await expect(
    capture.host.generateText!({
      sessionID: "session",
      model: { providerID: "fixture", id: "wrong" },
      prompt: "clean",
      signal: stop.signal,
    }),
  ).rejects.toThrow("model");
  expect((await iterator.next()).value).toEqual({ sessionID: "other" });
  await first;
  expect(await capture.host.readTranscript!("session")).toBeUndefined();
  expect(capture.host.defaultModel!("other")).toEqual({
    providerID: "fixture",
    id: "second",
  });
  expect(
    await capture.host.generateText!({
      sessionID: "other",
      model: { providerID: "fixture", id: "second" },
      prompt: "second clean prompt",
      signal: stop.signal,
    }),
  ).toBe("second answer");
  stop.abort();
  await second;
  expect((await iterator.next()).done).toBe(true);
  await capture.publish("late", {
    messages: [],
    model,
    generateText: async () => {
      throw new Error("late");
    },
  });
});

test("terminal turns capture through shared gates, redact secrets, and respect cooldowns", async () => {
  const prompts: string[] = [];
  const snapshot = binding(async (prompt) => {
    prompts.push(prompt);
    return ANSWER;
  });
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
  snapshot.messages = [
    ...snapshot.messages,
    { role: "user", content: `Temporary token ${secret}` },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "PRIVATE-THOUGHT" }],
    },
    {
      role: "toolResult",
      content: [{ type: "text", text: "RAW-TOOL-OUTPUT" }],
    },
    {
      role: "user",
      attribution: "agent",
      content: "SYNTHETIC-USER-PREFERENCE",
    },
  ];
  const d = await driver(() => snapshot);
  try {
    await d.ground();
    await d.emit("agent_end", { messages: [], willContinue: true });
    await d.emit("agent_end", { messages: [], awaitingAsyncWork: true });
    expect(prompts).toHaveLength(0);
    await d.emit("agent_end", { messages: [] });
    expect(prompts).toHaveLength(1);
    for (const privateText of [
      secret,
      "PRIVATE-THOUGHT",
      "RAW-TOOL-OUTPUT",
      "SYNTHETIC-USER-PREFERENCE",
    ])
      expect(prompts[0]).not.toInclude(privateText);
    const rows = await loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe(FACT);
    expect(rows[0]!.tags).toContain("auto-capture");
    expect(await d.recall()).toInclude(FACT);
    await d.emit("agent_end", { messages: [] });
    expect(prompts).toHaveLength(1);
  } finally {
    await d.close();
  }
});

test("a held capture keeps its original project when the host replaces the session", async () => {
  const entered = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<string>();
  const snapshot = binding(async () => {
    entered.resolve();
    return answer.promise;
  });
  const d = await driver(() => snapshot);
  let capturing: Promise<unknown> | undefined;
  try {
    await d.ground();
    capturing = d.emit("agent_end", { messages: [] });
    await entered.promise;
    const other = join(store.root, "other");
    mkdirSync(other);
    await d.move(other);
    answer.resolve(ANSWER);
    await capturing;
    const rows = await loadAll();
    expect(rows).toHaveLength(1);
    expect(normalizeDirPath(rows[0]!.repoPath!)).toBe(
      normalizeDirPath(store.root),
    );
    expect(await d.recall()).not.toInclude(FACT);
    await d.move(store.root);
    expect(await d.recall()).toInclude(FACT);
  } finally {
    answer.resolve("[]");
    await capturing;
    await d.close();
  }
});

test("generation failures and missing grounding cannot write, and a new session can recover", async () => {
  let calls = 0;
  const d = await driver(() =>
    binding(async () => {
      if (++calls === 1) throw new Error("provider failed");
      return ANSWER;
    }),
  );
  try {
    await d.emit("agent_end", { messages: [] });
    expect(await loadAll()).toEqual([]);
    await d.move(store.root);
    await d.emit("agent_end", { messages: [] });
    expect(await loadAll()).toEqual([]);
    await d.move(store.root);
    await d.ground();
    await d.emit("agent_end", { messages: [] });
    expect(calls).toBe(3);
    expect((await loadAll()).map((m) => m.content)).toEqual([FACT]);
  } finally {
    await d.close();
  }
});

test("shutdown aborts unanswered generation and prevents late capture writes", async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const answer = Promise.withResolvers<string>();
  const d = await driver(() =>
    binding(async (_prompt, signal) => {
      entered.resolve(signal);
      return answer.promise;
    }),
  );
  let capturing: Promise<unknown> | undefined;
  try {
    await d.ground();
    capturing = d.emit("agent_end", { messages: [] });
    const signal = await entered.promise;
    const stopped = d.close();
    // Disposal begins synchronously; the model response is deliberately late.
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    answer.resolve(ANSWER);
    await stopped;
    await capturing;
    await d.emit("agent_end", { messages: [] });
    expect(await loadAll()).toEqual([]);
  } finally {
    answer.resolve("[]");
    await capturing;
    await d.close();
  }
});

test("disabled capture and invalid model configuration do not leave host callbacks waiting", async () => {
  for (const options of [{ autoCapture: false }, { captureModel: "invalid" }]) {
    const d = await driver(
      () =>
        binding(async () => {
          throw new Error("must not generate");
        }),
      options,
    );
    try {
      await d.emit("agent_end", { messages: [] });
    } finally {
      await d.close();
    }
  }
}, 2000);

test("missing model bindings and thin transcripts skip generation without stranding later turns", async () => {
  let current: OmpCaptureBinding | undefined;
  let calls = 0;
  const complete = binding(async () => {
    calls++;
    return ANSWER;
  });
  const d = await driver(() => current);
  try {
    await d.emit("agent_end", { messages: [] });
    current = { ...complete, messages: [{ role: "user", content: "Hi" }] };
    await d.emit("agent_end", { messages: [] });
    expect(calls).toBe(0);
    expect(await loadAll()).toEqual([]);
    await d.move(store.root);
    current = complete;
    await d.ground();
    await d.emit("agent_end", { messages: [] });
    expect(calls).toBe(1);
    expect((await loadAll()).map((m) => m.content)).toEqual([FACT]);
  } finally {
    await d.close();
  }
});
