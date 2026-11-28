import { createOhMyPiMemory } from "../../src/adapters/oh-my-pi/extension.ts";
import type {
  OmpAPI,
  OmpContext,
  OmpEvents,
  OmpTool,
} from "../../src/adapters/oh-my-pi/context.ts";
import { textContent } from "../../src/adapters/oh-my-pi/delivery.ts";
import type { MemorySetupOptions } from "../../src/host/runtime.ts";
import type { LifecycleHandlers } from "../../src/host/lifecycle.ts";
import type { MemoryTool } from "../../src/host/contracts.ts";
import type { CaptureTranscript } from "../../src/host/capture.ts";
import type { RuntimeDriver } from "../host/runtime-contract.ts";
import { ControlledCall, Trace } from "../simulator/control.ts";

/** Drive native extension callbacks with a controlled capture binding. */
export async function ohMyPiRuntimeDriver(
  config: MemorySetupOptions,
): Promise<RuntimeDriver> {
  const nativeTools = new Map<string, OmpTool>();
  const tools = new Map<string, MemoryTool>();
  const transcripts = new Map<string, CaptureTranscript>();
  const directories = new Map<string, string>();
  const entries = new Map<string, unknown[]>();
  const callbacks = new Map<
    string,
    (event: any, ctx: OmpContext) => Promise<any>
  >();
  const generation = new ControlledCall<{ prompt: string }, string>(
    new Trace(),
    "oh-my-pi",
    "generation",
    () => "[]",
  );
  const context = (sid: string): OmpContext => ({
    cwd: directories.get(sid) ?? config.directory!,
    sessionManager: {
      getSessionId: () => sid,
      getEntries: () => entries.get(sid) ?? [],
    },
  });
  const native = async <K extends keyof OmpEvents>(
    name: K,
    event: OmpEvents[K],
    sid = "fixture",
  ) => callbacks.get(name)?.(event, context(sid));
  let calls = 0;
  async function invoke(sid: string, name: string, args: unknown) {
    const tool = nativeTools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const result = await tool.execute(
      `${sid}-${++calls}`,
      args,
      undefined,
      undefined,
      context(sid),
    );
    return { content: textContent(result.content) };
  }
  const api: OmpAPI = {
    on(name, handler) {
      callbacks.set(name, handler);
    },
    registerTool(tool) {
      nativeTools.set(tool.name, tool);
      tools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        input: tool.parameters,
        execute: (args, call) =>
          invoke(call?.sessionID ?? "fixture", tool.name, args),
      });
    },
  };
  await createOhMyPiMemory({
    options: config.options,
    capture(ctx) {
      const sid = ctx.sessionManager.getSessionId();
      return {
        messages: (transcripts.get(sid) ?? []).map((m) => ({
          role: m.role,
          content: m.text,
          timestamp: m.timestamp,
        })),
        model: { providerID: "fixture", id: "scripted" },
        // Allow an answer after abort to check the shared late-answer guard.
        generateText: (prompt) => generation.call({ prompt }),
      };
    },
  })(api);
  const emitters = {
    beforeTool: async (event) => {
      await native(
        "tool_call",
        { toolName: event.tool!, toolCallId: event.callID! },
        event.sessionID,
      );
    },
    async afterTool(event) {
      const result = await native(
        "tool_result",
        {
          toolName: event.tool!,
          toolCallId: event.callID!,
          input: event.args as Record<string, unknown>,
          content: [{ type: "text", text: event.text }],
          details: event.metadata,
          isError: false,
        },
        event.sessionID,
      );
      if (result?.content) event.appendResult(textContent(result.content));
    },
    async context(event) {
      await native(
        "context",
        {
          messages: event.observedResults.map((part) => ({
            role: "toolResult",
            toolCallId: part.callID,
            toolName: part.tool,
            content: [{ type: "text", text: part.text }],
          })),
        },
        event.sessionID,
      );
    },
    async prompt(event) {
      await native(
        "before_agent_start",
        { reason: "prompt", prompt: event.text, systemPrompt: [] },
        event.sessionID,
      );
    },
    async compact(event) {
      const sid = event.sessionID ?? "fixture";
      if (event.phase !== "complete") {
        const result = await native(
          "session.compacting",
          { sessionId: sid, messages: [] },
          sid,
        );
        for (const text of result?.context ?? []) event.appendSystem?.(text);
      }
      if (event.phase !== "prepare") await native("session_compact", {}, sid);
    },
    async identity(event) {
      if (event.directory) directories.set(event.sessionID, event.directory);
      await native("session_switch", {}, event.sessionID);
    },
    async usage(event) {
      entries.set(event.sessionID, [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: event.input,
              cacheRead: event.read,
              cacheWrite: event.write,
              output: event.output + (event.reasoning ?? 0),
              reasoningTokens: event.reasoning,
            },
          },
        },
      ]);
      await native("session_start", {}, event.sessionID);
    },
    async error() {
      throw new Error("oh-my-pi has no native lifecycle-error event");
    },
  } satisfies {
    [K in keyof LifecycleHandlers]: (
      event: Parameters<LifecycleHandlers[K]>[0],
    ) => Promise<void>;
  };
  const driver: RuntimeDriver = {
    tools,
    transcripts,
    generation,
    invoke,
    async emit(name, event) {
      const send = emitters[name] as (input: typeof event) => Promise<void>;
      await send(event);
    },
    async ground(sessionID) {
      await native(
        "tool_result",
        {
          toolName: "read",
          toolCallId: `${sessionID}-read`,
          input: {},
          content: [{ type: "text", text: "observed" }],
          isError: false,
        },
        sessionID,
      );
    },
    async request(sessionID, text) {
      const result = await native(
        "before_agent_start",
        { reason: "prompt", prompt: text, systemPrompt: [] },
        sessionID,
      );
      return (result?.systemPrompt ?? []).join("\n");
    },
    async context(sessionID, options = {}) {
      const observedResults = structuredClone([
        ...(options.observedResults ?? []),
      ]);
      await emitters.context({ sessionID, observedResults });
      return { sessionID, observedResults, system: [], attemptedSystem: [] };
    },
    async turnEnd(sessionID) {
      await native("agent_end", { messages: [] }, sessionID);
    },
    async dispose() {
      await native("session_shutdown", {});
    },
    async close() {
      const cleanup = driver.dispose();
      generation.close();
      await cleanup;
    },
  };
  return driver;
}
