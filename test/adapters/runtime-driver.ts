import type {
  PluginCtx,
  OpenCodeTool,
} from "../../src/adapters/opencode/context.ts";
import { createOpenCodeMemoryHost } from "../../src/adapters/opencode/memory-host.ts";
import { setupMemory } from "../../src/runtime/setup.ts";
import type { CaptureTranscript } from "../../src/host/capture.ts";
import type { LifecycleHandlers } from "../../src/host/lifecycle.ts";
import type { MemorySetupOptions } from "../../src/host/runtime.ts";
import type { RuntimeDriver } from "../host/runtime-contract.ts";
import { ControlledCall, Trace, checkpoint } from "../simulator/control.ts";

type Delivery = {
  value: unknown;
  error?: unknown;
  done: ReturnType<typeof Promise.withResolvers<void>>;
};
type Subscriber = {
  queue: Delivery[];
  wake: ReturnType<typeof Promise.withResolvers<void>>;
};

/** Both native subscriptions see each event; acknowledgements replace sleeps. */
class Events {
  private subscribers = new Set<Subscriber>();
  async *subscribe(signal?: AbortSignal): AsyncIterable<unknown> {
    const sub: Subscriber = { queue: [], wake: Promise.withResolvers<void>() };
    this.subscribers.add(sub);
    const abort = () => sub.wake.resolve();
    signal?.addEventListener("abort", abort, { once: true });
    let current: Delivery | undefined;
    try {
      while (!signal?.aborted) {
        if (!sub.queue.length) {
          await sub.wake.promise;
          sub.wake = Promise.withResolvers<void>();
          continue;
        }
        current = sub.queue.shift()!;
        if (current.error !== undefined) throw current.error;
        yield current.value;
        current.done.resolve();
        current = undefined;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.subscribers.delete(sub);
      current?.done.resolve();
      for (const item of sub.queue) item.done.resolve();
    }
  }
  async publish(value: unknown, error?: unknown): Promise<void> {
    await Promise.all(
      [...this.subscribers].map((sub) => {
        const done = Promise.withResolvers<void>();
        sub.queue.push({ value, error, done });
        sub.wake.resolve();
        return checkpoint("native event handled", done.promise);
      }),
    );
  }
}

function nativeTranscript(transcript: CaptureTranscript | undefined) {
  return transcript?.map((message) => ({
    type: message.role ?? "idle",
    text: message.text,
    time: { created: message.timestamp },
  }));
}

/** Feed native payloads through the production adapter, never normalized handlers. */
export async function openCodeRuntimeDriver(
  config: MemorySetupOptions,
): Promise<RuntimeDriver> {
  const tools = new Map<string, OpenCodeTool>();
  const transcripts = new Map<string, CaptureTranscript>();
  const generation = new ControlledCall<
    { prompt: string; model: { providerID: string; id: string } },
    string
  >(new Trace(), "opencode", "generation", () => "[]");
  const events = new Events();
  const hooks = new Map<string, (event: any) => void | Promise<void>>();
  const hook = async (
    name: string,
    callback: (event: any) => void | Promise<void>,
  ) => {
    hooks.set(name, callback);
    return {
      dispose() {
        hooks.delete(name);
      },
    };
  };
  const ctx: PluginCtx = {
    location: { directory: config.directory },
    tool: {
      hook,
      async transform(edit) {
        edit({
          add: (tool) => {
            tools.set(tool.name, tool);
          },
        });
      },
    },
    session: {
      hook,
      async get() {
        return { directory: config.directory };
      },
      async context({ sessionID }) {
        return nativeTranscript(transcripts.get(sessionID));
      },
    },
    event: { subscribe: (options) => events.subscribe(options?.signal) },
    model: {
      async default() {
        return { data: { providerID: "fixture", modelID: "scripted" } };
      },
    },
    // Deliberately allow late answers to exercise the engine's abandonment guard.
    generate: { text: (input) => generation.call(input) },
  };
  const runtime = await setupMemory(createOpenCodeMemoryHost(ctx), config);
  const native = async (name: string, event: unknown) => {
    await hooks.get(name)?.(event);
  };
  const emitters = {
    beforeTool: (event) => native("execute.before", event),
    async afterTool(event) {
      const result = { content: event.text, metadata: event.metadata };
      await native("execute.after", { ...event, input: event.args, result });
      if (result.content !== event.text) event.appendResult(result.content);
    },
    async context(event) {
      const system: Array<{ type: string; text: string }> | undefined =
        event.appendSystem ? [] : undefined;
      await native("context", {
        sessionID: event.sessionID,
        model: event.model,
        system,
        messages: [
          {
            role: "tool",
            content: event.observedResults.map((part) => ({
              type: "tool-result",
              id: part.callID,
              name: part.tool,
              result: { type: "text", value: part.text },
            })),
          },
        ],
      });
      for (const part of system ?? []) event.appendSystem?.(part.text);
    },
    prompt: (event) =>
      native("prompt", {
        sessionID: event.sessionID,
        prompt: { text: event.text },
      }),
    async compact(event) {
      if (event.phase || event.capture === false || event.captureStarted)
        throw new Error("OpenCode exposes combined compaction only");
      const system: Array<{ type: string; text: string }> | undefined =
        event.appendSystem ? [] : undefined;
      await native("compaction", {
        sessionID: event.sessionID,
        messages: nativeTranscript(event.transcript),
        system,
      });
      for (const part of system ?? []) event.appendSystem?.(part.text);
    },
    identity: (event) =>
      events.publish({
        type: "session.moved",
        data: {
          sessionID: event.sessionID,
          location: { directory: event.directory },
        },
      }),
    usage: (event) => {
      const info = {
        sessionID: event.sessionID,
        id: event.messageID,
        role: "assistant",
        tokens: {
          input: event.input,
          output: event.output,
          reasoning: event.reasoning,
          cache: { read: event.read, write: event.write },
        },
      };
      return events.publish(
        event.cumulative
          ? { type: "session.usage.updated", data: info }
          : { type: "message.updated", properties: { info } },
      );
    },
    error: (error) => events.publish(undefined, error),
  } satisfies {
    [K in keyof LifecycleHandlers]: (
      event: Parameters<LifecycleHandlers[K]>[0],
    ) => Promise<void>;
  };
  let calls = 0;
  let closed = false;
  const driver: RuntimeDriver = {
    tools,
    transcripts,
    generation,
    async emit(name, event) {
      const send = emitters[name] as (input: typeof event) => Promise<void>;
      await send(event);
    },
    async invoke(sessionID, name, args) {
      if (closed) throw new Error("Host is not active");
      const tool = tools.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool.execute(args, {
        sessionID,
        callID: `${sessionID}-${++calls}`,
      });
    },
    async ground(sessionID) {
      await native("execute.after", {
        sessionID,
        callID: `${sessionID}-read`,
        tool: "read",
        input: {},
        result: { content: "observed" },
      });
    },
    async context(sessionID, options = {}) {
      const request = {
        sessionID,
        observedResults: structuredClone([...(options.observedResults ?? [])]),
        attemptedSystem: [] as string[],
        system: [] as string[],
      };
      await driver.emit("context", {
        sessionID,
        observedResults: request.observedResults,
        model: options.model,
        appendSystem:
          options.system === false
            ? undefined
            : (text) => {
                request.attemptedSystem.push(text);
                request.system.push(
                  options.clip === undefined
                    ? text
                    : text.slice(0, options.clip),
                );
              },
      });
      return request;
    },
    async request(sessionID, text) {
      await driver.emit("prompt", { sessionID, text });
      return (await driver.context(sessionID)).system.join("\n");
    },
    async turnEnd(sessionID) {
      if (!closed)
        await events.publish({
          type: "session.execution.succeeded",
          data: { sessionID },
        });
    },
    dispose() {
      closed = true;
      return runtime.dispose();
    },
    async close() {
      const cleanup = driver.dispose();
      generation.close();
      await cleanup;
    },
  };
  return driver;
}
