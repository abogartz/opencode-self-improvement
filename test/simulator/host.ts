import { setupMemory } from "../../src/runtime/setup.ts";
import type {
  MemoryHost,
  MemoryRuntime,
  MemorySetupOptions,
} from "../../src/host/runtime.ts";
import type { MemoryTool } from "../../src/host/contracts.ts";
import type {
  CaptureTranscript,
  CaptureTurnEnd,
} from "../../src/host/capture.ts";
import type {
  LifecycleHandlers,
  ObservedToolResult,
  ContextEvent,
} from "../../src/host/lifecycle.ts";
import type { SessionModelRef } from "../../src/capture/session-model.ts";
import type { HostCapabilities } from "../../src/host/capabilities.ts";
import { ControlledCall, Trace, checkpoint } from "./control.ts";

type EventName = keyof LifecycleHandlers;
type QueuedTurn = {
  event: CaptureTurnEnd;
  done: ReturnType<typeof Promise.withResolvers<void>>;
};
export interface HostOptions extends MemorySetupOptions {
  harness?: string;
  capabilities?: Partial<
    Record<
      | "events"
      | "transcript"
      | "generation"
      | "defaultModel"
      | "tools"
      | "commands"
      | "transcriptDirectory"
      | "sessionDirectory"
      | "identityEvents"
      | "usageReceipts"
      | "toolEvents"
      | "promptEvents"
      | "system"
      | "toolResults"
      | "observedToolResults",
      boolean
    >
  >;
  compaction?: HostCapabilities["compaction"];
}
export interface RequestCopy {
  sessionID: string;
  observedResults: ObservedToolResult[];
  attemptedSystem: string[];
  system: string[];
}

/** A programmable host of the real shared engine. No vendor SDK or model service. */
export class TestHost {
  readonly tools = new Map<string, MemoryTool>();
  readonly transcripts = new Map<string, CaptureTranscript>();
  readonly directories = new Map<string, string>();
  readonly transcriptDirectories = new Map<string, string>();
  model: SessionModelRef | null = { providerID: "simulator", id: "scripted" };
  resolveModel: (sessionID?: string) => SessionModelRef | null = () =>
    this.model;
  readonly modelLookups: Array<string | undefined> = [];
  readonly modelReads: ControlledCall<
    string | undefined,
    SessionModelRef | null
  >;
  readonly requests: RequestCopy[] = [];
  readonly generation: ControlledCall<
    { sessionID: string; model: SessionModelRef; prompt: string },
    string
  >;
  readonly generationSignals: AbortSignal[] = [];
  readonly transcriptReads: ControlledCall<
    string,
    CaptureTranscript | undefined
  >;
  readonly registration: ControlledCall<void, void>;
  readonly toolRegistration: ControlledCall<void, void>;
  readonly commands: ControlledCall<void, void>;
  readonly sessionDirectoryReads: ControlledCall<string, string | undefined>;
  readonly transcriptDirectoryReads: ControlledCall<string, string | undefined>;
  readonly disposal: ControlledCall<void, void>;
  readonly host: MemoryHost;
  private handlers?: LifecycleHandlers;
  private runtime?: MemoryRuntime;
  private started = false;
  private starting?: Promise<MemoryRuntime>;
  private active = false;
  private closing = false;
  private subscribed = false;
  private turns: QueuedTurn[] = [];
  private wake = Promise.withResolvers<void>();
  private calls = 0;
  private operations = new Set<Promise<unknown>>();

  readonly name: string;
  readonly trace: Trace;
  private config: HostOptions;
  constructor(name: string, config: HostOptions = {}, trace = new Trace()) {
    this.name = name;
    this.config = config;
    this.trace = trace;
    this.generation = new ControlledCall(trace, name, "generation", () => "[]");
    this.transcriptReads = new ControlledCall(
      trace,
      name,
      "transcript",
      (sid) => structuredClone(this.transcripts.get(sid)),
    );
    this.registration = new ControlledCall(
      trace,
      name,
      "registration",
      () => {},
    );
    this.disposal = new ControlledCall(trace, name, "disposal", () => {});
    this.modelReads = new ControlledCall(trace, name, "model", (sid) =>
      this.resolveModel(sid),
    );
    this.toolRegistration = new ControlledCall(
      trace,
      name,
      "toolRegistration",
      () => {},
    );
    this.commands = new ControlledCall(trace, name, "commands", () => {});
    this.sessionDirectoryReads = new ControlledCall(
      trace,
      name,
      "sessionDirectory",
      (sid) => this.directories.get(sid),
    );
    this.transcriptDirectoryReads = new ControlledCall(
      trace,
      name,
      "transcriptDirectory",
      (sid) => this.transcriptDirectories.get(sid),
    );
    const available = (key: keyof NonNullable<HostOptions["capabilities"]>) =>
      config.capabilities?.[key] !== false;
    this.host = {
      capabilities: {
        tools: available("tools"),
        identityEvents: available("identityEvents"),
        usageReceipts: available("usageReceipts"),
        toolEvents: available("toolEvents"),
        promptEvents: available("promptEvents"),
        context: {
          system: available("system"),
          toolResults: available("toolResults"),
          observedToolResults: available("observedToolResults"),
          promptDependentCache: available("system") ? "unknown" : "unavailable",
        },
        compaction: config.compaction ?? "combined",
        shutdown: { cooperative: "awaited", forcedExit: "no-cleanup" },
      },
      harness: config.harness ?? "simulator",
      installCommands: available("commands")
        ? () => this.commands.call()
        : undefined,
      tools: {
        directories: {
          fromSession: available("sessionDirectory")
            ? (sid) => this.sessionDirectoryReads.call(sid)
            : undefined,
          fromTranscript: available("transcriptDirectory")
            ? (sid) => this.transcriptDirectoryReads.call(sid)
            : undefined,
        },
        registerTools: async (register) => {
          if (!available("tools")) return;
          await this.toolRegistration.call();
          register({
            add: (tool) => {
              this.tools.set(tool.name, tool);
            },
          });
          trace.add(name, "tools.registered", [...this.tools.keys()]);
        },
      },
      lifecycle: {
        register: async (handlers) => {
          await this.registration.call();
          this.handlers = handlers;
          this.active = true;
          return {
            dispose: () => {
              this.active = false;
              trace.add(name, "lifecycle.stopped");
              return this.disposal.call();
            },
          };
        },
      },
      capture: {
        subscribedEvents: ["simulator.turn-end"],
        turnEndEvents:
          config.capabilities?.events === false
            ? undefined
            : (signal) => this.events(signal),
        readTranscript:
          config.capabilities?.transcript === false
            ? undefined
            : (sid) => this.transcriptReads.call(sid),
        generateText:
          config.capabilities?.generation === false
            ? undefined
            : ({ signal, ...input }) => {
                // Signals are live, not structured-cloneable request data.
                // Keep responses controllable after abort to test late answers.
                this.generationSignals.push(signal);
                return this.generation.call(input);
              },
        defaultModel: available("defaultModel")
          ? (sid) => {
              this.modelLookups.push(sid);
              trace.add(name, "model.lookup", sid);
              return this.modelReads.call(sid);
            }
          : undefined,
      },
    };
  }
  get closed(): boolean {
    return this.closing;
  }
  start(): Promise<MemoryRuntime> {
    if (this.started || this.closing)
      throw new Error("Host instances start once");
    this.started = true;
    this.trace.add(this.name, "setup.begin");
    this.starting = setupMemory(this.host, {
      directory: this.config.directory,
      options: { autoCapture: false, ...this.config.options },
    }).then(
      (runtime) => {
        this.runtime = runtime;
        this.trace.add(this.name, "setup.ready");
        return runtime;
      },
      (error) => {
        this.trace.add(this.name, "setup.failed", String(error));
        throw error;
      },
    );
    return this.track(this.starting);
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.operations.add(promise);
    void promise.then(
      () => this.operations.delete(promise),
      () => this.operations.delete(promise),
    );
    return promise;
  }
  async emit<K extends EventName>(
    name: K,
    event: Parameters<LifecycleHandlers[K]>[0],
  ): Promise<void> {
    const capabilities = this.host.capabilities;
    const enabled = {
      beforeTool: capabilities.toolEvents,
      afterTool: capabilities.toolEvents,
      context: true,
      prompt: capabilities.promptEvents,
      compact: capabilities.compaction !== "unavailable",
      identity: capabilities.identityEvents,
      usage: capabilities.usageReceipts,
      error: true,
    } satisfies Record<EventName, boolean>;
    if (!this.active || !this.handlers || !enabled[name]) {
      this.trace.add(this.name, `${name}.dropped`);
      return;
    }
    this.trace.add(this.name, `${name}.begin`, event);
    const handler = this.handlers[name] as (
      event: Parameters<LifecycleHandlers[K]>[0],
    ) => void | Promise<void>;
    try {
      await this.track(Promise.resolve(handler(event)));
      this.trace.add(this.name, `${name}.end`);
    } catch (error) {
      this.trace.add(this.name, `${name}.failed`, String(error));
      throw error;
    }
  }
  async invoke(sid: string, name: string, args: unknown) {
    if (!this.active || this.closing) throw new Error("Host is not active");
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    this.trace.add(this.name, "tool.invoke", { sid, name, args });
    const result = await this.track(
      tool.execute(args, { sessionID: sid, callID: `${sid}-${++this.calls}` }),
    );
    this.trace.add(this.name, "tool.returned", result);
    return result;
  }
  async move(sid: string, directory: string): Promise<void> {
    this.directories.set(sid, directory);
    await this.emit("identity", { sessionID: sid, directory });
  }
  async ground(sid: string): Promise<void> {
    await this.toolResult(sid, `${sid}-read`, "observed");
  }
  async toolResult(
    sid: string,
    callID: string,
    text: string,
    options: { clip?: number; writeback?: boolean; tool?: string } = {},
  ): Promise<ObservedToolResult> {
    const result = { callID, tool: options.tool ?? "read", text };
    await this.emit("afterTool", {
      sessionID: sid,
      callID,
      tool: result.tool,
      args: {},
      text,
      metadata: {},
      appendResult: (after) => {
        if (
          options.writeback === false ||
          !this.host.capabilities.context.toolResults
        )
          return false;
        result.text = after;
        this.trace.add(this.name, "tool.placed", after);
        return true;
      },
    });
    // A later host transformation is observable only in the outgoing request.
    if (options.clip !== undefined)
      result.text = result.text.slice(0, options.clip);
    this.trace.add(this.name, "tool.delivered", result);
    return result;
  }
  async context(
    sid: string,
    options: {
      observedResults?: readonly ObservedToolResult[];
      system?: boolean;
      clip?: number;
      model?: SessionModelRef;
    } = {},
  ): Promise<RequestCopy> {
    const request: RequestCopy = {
      sessionID: sid,
      observedResults: this.host.capabilities.context.observedToolResults
        ? structuredClone([...(options.observedResults ?? [])])
        : [],
      attemptedSystem: [],
      system: [],
    };
    this.requests.push(request);
    const event: ContextEvent = {
      sessionID: sid,
      observedResults: request.observedResults,
      model: options.model,
      appendSystem:
        options.system === false || !this.host.capabilities.context.system
          ? undefined
          : (text) => {
              request.attemptedSystem.push(text);
              request.system.push(
                options.clip === undefined ? text : text.slice(0, options.clip),
              );
            },
    };
    await this.emit("context", event);
    this.trace.add(this.name, "request.delivered", request);
    return structuredClone(request);
  }
  async request(sid: string, text: string): Promise<string> {
    await this.emit("prompt", { sessionID: sid, text });
    return (await this.context(sid)).system.join("\n");
  }
  turnEnd(sessionID?: string): Promise<void> {
    if (this.closing) {
      this.trace.add(this.name, "turnEnd.dropped", { sessionID });
      return Promise.resolve();
    }
    if (!this.subscribed)
      return Promise.reject(
        new Error("Capture event subscription is unavailable"),
      );
    const item: QueuedTurn = {
      event: { sessionID },
      done: Promise.withResolvers<void>(),
    };
    this.turns.push(item);
    this.trace.add(this.name, "turnEnd.queued", item.event);
    this.wake.resolve();
    return this.track(checkpoint("turn-end handled", item.done.promise));
  }
  private async *events(signal: AbortSignal): AsyncIterable<CaptureTurnEnd> {
    this.subscribed = true;
    const abort = () => {
      this.trace.add(this.name, "capture.aborted");
      this.wake.resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    let current: QueuedTurn | undefined;
    try {
      while (!signal.aborted && !this.closing) {
        if (!this.turns.length) {
          await this.wake.promise;
          this.wake = Promise.withResolvers<void>();
          continue;
        }
        current = this.turns.shift();
        if (!current) continue;
        this.trace.add(this.name, "turnEnd.dispatched", current.event);
        yield current.event;
        // Resumption means the shared consumer finished handling this event.
        current.done.resolve();
        current = undefined;
      }
    } finally {
      this.subscribed = false;
      signal.removeEventListener("abort", abort);
      current?.done.resolve();
      for (const item of this.turns.splice(0)) {
        this.trace.add(this.name, "turnEnd.dropped", item.event);
        item.done.resolve();
      }
    }
  }
  dispose(): Promise<void> {
    this.closing = true;
    this.active = false;
    this.wake.resolve();
    this.trace.add(this.name, "dispose.begin");
    return this.runtime?.dispose() ?? Promise.resolve();
  }
  async close(): Promise<void> {
    const cleanup = this.dispose();
    void cleanup.catch(() => {});
    this.generation.close();
    this.modelReads.close();
    this.transcriptReads.close();
    this.registration.close();
    this.toolRegistration.close();
    this.commands.close();
    this.sessionDirectoryReads.close();
    this.transcriptDirectoryReads.close();
    this.disposal.close();
    await this.starting?.catch(() => {});
    const results = await Promise.allSettled([
      this.runtime?.dispose() ?? cleanup,
      ...this.operations,
    ]);
    this.trace.add(this.name, "dispose.end");
    if (results[0]?.status === "rejected") throw results[0].reason;
  }
}
