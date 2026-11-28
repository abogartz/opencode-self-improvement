import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { MemoryTool } from "../../host/contracts.ts";
import type { LifecycleHandlers } from "../../host/lifecycle.ts";
import type { MemoryRuntime } from "../../host/runtime.ts";
import { setupMemory } from "../../runtime/setup.ts";
import {
  createPiCapture,
  type PiCaptureBinding,
} from "../pi-family/capture.ts";
import { memoryOptions } from "../pi-family/config.ts";
import {
  appendPull,
  observedToolResults,
  textContent,
} from "../pi-family/delivery.ts";
import { sessionUsage } from "../pi-family/usage.ts";
import { bindCompletion } from "./completion.ts";
import { compactWithMemory } from "./compaction.ts";
import { piCapabilities } from "./capabilities.ts";

export interface PiMemoryConfig {
  options?: Record<string, unknown>;
  capture?: (ctx: ExtensionContext) => PiCaptureBinding | undefined;
  compaction?: typeof compactWithMemory;
}

export type PiAPI = Pick<
  ExtensionAPI,
  "on" | "registerCommand" | "sendMessage"
> & {
  registerTool(tool: ToolDefinition): void;
};

/** Native Pi lifecycle glue. Policy, tools, storage and capture gates are shared. */
export async function installPiMemory(pi: PiAPI, config: PiMemoryConfig) {
  const options = memoryOptions(config.options, {
    name: "pi",
    configEnv: "PI_MEMORY_CONFIG",
  });
  const namespace = `pi:${randomUUID()}:`;
  const capture = createPiCapture("pi", "agent_settled");
  const pending = new Set<Promise<unknown>>();
  const tools = new Map<string, MemoryTool>();
  const compactions = new Map<
    string,
    { binding: PiCaptureBinding; signal: AbortSignal }
  >();
  let handlers: LifecycleHandlers | undefined;
  let runtime: MemoryRuntime | undefined;
  let starting: Promise<void> | undefined;
  let generation = 0;
  let closed = false;
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  function identity(ctx: ExtensionContext) {
    const id = ctx.sessionManager.getSessionId();
    if (!id?.trim() || !ctx.cwd?.trim() || !isAbsolute(ctx.cwd))
      throw new Error(
        "Pi memory requires a session and absolute workspace identity",
      );
    const sessionID = `${namespace}${generation}:${id}`;
    handlers!.identity({ sessionID, directory: ctx.cwd });
    return sessionID;
  }
  const usage = async (sid: string, ctx: ExtensionContext) => {
    const receipt = sessionUsage(ctx, sid, "reasoning");
    if (receipt) await handlers!.usage(receipt);
  };
  const active = () => !closed && handlers !== undefined;
  pi.on("session_shutdown", async (_event, ctx) => {
    if (active()) {
      try {
        track(usage(identity(ctx), ctx));
      } catch {
        /* Cleanup survives missing identity. */
      }
    }
    closed = true;
    compactions.clear();
    await starting;
    if (!config.capture) await capture.settle(500);
    await runtime?.dispose();
  });
  // Pi can load factories without ever creating a session (e.g. listing packages).
  pi.on("session_start", async (_event, ctx) => {
    if (closed) return;
    if (!starting) starting = start();
    await starting;
    if (active()) await track(usage(identity(ctx), ctx));
  });
  async function start() {
    try {
      runtime = await setupMemory(
        {
          harness: "pi",
          capabilities: piCapabilities,
          tools: {
            directories: {},
            async registerTools(register) {
              register({
                add(tool) {
                  tools.set(tool.name, tool);
                  pi.registerTool({
                    name: tool.name,
                    label: tool.name,
                    description: tool.description,
                    parameters: tool.input,
                    async execute(callID, args, signal, _update, ctx) {
                      if (!active()) throw new Error("Pi memory is closed");
                      signal?.throwIfAborted();
                      const result = await track(
                        tool.execute(args, {
                          sessionID: identity(ctx),
                          callID,
                        }),
                      );
                      return {
                        content: [{ type: "text", text: result.content }],
                        details: {},
                      };
                    },
                  });
                },
              });
            },
          },
          lifecycle: {
            async register(shared) {
              handlers = shared;
              return {
                async dispose() {
                  closed = true;
                  capture.close();
                  await Promise.allSettled([...pending]);
                },
              };
            },
          },
          capture: capture.host,
        },
        {
          options: {
            autoCapture: true,
            ...options,
            ...(Array.isArray(options.pullTools)
              ? {
                  pullTools: options.pullTools.map((tool) =>
                    typeof tool === "string" ? sharedTool(tool) : tool,
                  ),
                }
              : {}),
          },
        },
      );
      if (closed) await runtime.dispose();
    } catch (error) {
      closed = true;
      capture.close();
      throw error;
    }
  }
  pi.on("before_agent_start", async (event, ctx) => {
    if (!active() || event.messageType !== "user") return;
    const sid = identity(ctx);
    compactions.clear();
    const systemPrompt = [event.systemPrompt];
    await track(
      (async () => {
        await handlers!.prompt({ sessionID: sid, text: event.prompt });
        await handlers!.context({
          sessionID: sid,
          observedResults: [],
          appendSystem: (text) => systemPrompt.push(text),
        });
      })(),
    );
    return { systemPrompt: systemPrompt.join("\n\n") };
  });
  pi.on("context", async (event, ctx) => {
    if (!active()) return;
    await track(
      handlers!.context({
        sessionID: identity(ctx),
        observedResults: observedToolResults(event.messages).map((result) => ({
          ...result,
          tool: sharedTool(result.tool),
        })),
      }),
    );
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!active()) return;
    await track(
      handlers!.beforeTool({
        sessionID: identity(ctx),
        callID: event.toolCallId,
        tool: sharedTool(event.toolName),
      }),
    );
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!active()) return;
    const metadata = toolMetadata(event);
    if (
      event.isError &&
      !(typeof metadata.exitCode === "number" && metadata.exitCode !== 0)
    )
      return;
    const text = textContent(event.content);
    let content: ReturnType<typeof appendPull>;
    await track(
      handlers!.afterTool({
        sessionID: identity(ctx),
        callID: event.toolCallId,
        tool: sharedTool(event.toolName),
        args: event.input,
        text,
        metadata,
        appendResult: (after) => {
          if (
            event.isError ||
            (typeof metadata.exitCode === "number" && metadata.exitCode !== 0)
          )
            return false;
          content = appendPull(event.content, text, after);
          return content !== undefined;
        },
      }),
    );
    // Preserve Pi's machine-readable output when appending human-readable context.
    if (content) return { content, structuredContent: event.structuredContent };
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (active()) await track(usage(identity(ctx), ctx));
  });
  pi.on("agent_settled", async (event, ctx) => {
    if (!active() || event.aborted || options.autoCapture === false) return;
    const sid = identity(ctx);
    // agent_end carries only the latest loop's delta. A stable branch snapshot
    // retains cursor slots across user turns and excludes synthetic summaries.
    const binding = config.capture
      ? config.capture(ctx)
      : bindCompletion(
          ctx,
          ctx.sessionManager
            .getBranch()
            .map((entry) => (entry.type === "message" ? entry.message : {})),
          options.captureModel,
        );
    if (!binding) return;
    const captured = capture.publish(sid, binding);
    // Pi joins settlement before resolving prompt(). Background capture must not
    // hold the interactive turn open; shutdown grants it a bounded grace period.
    if (config.capture) await captured;
  });
  pi.on("session_tree", async (_event, ctx) => {
    if (!active()) return;
    generation++;
    compactions.clear();
    await track(usage(identity(ctx), ctx));
  });
  pi.on("session_before_compact", async (event, ctx) => {
    if (!active()) return;
    const sid = identity(ctx);
    compactions.clear();
    if (event.signal.aborted) return;
    if (options.autoCapture !== false && options.captureOnCompact !== false) {
      const binding = config.capture
        ? config.capture(ctx)
        : bindCompletion(
            ctx,
            [
              ...event.preparation.messagesToSummarize,
              ...event.preparation.turnPrefixMessages,
            ],
            options.captureModel,
          );
      if (binding) compactions.set(sid, { binding, signal: event.signal });
    }
    return track(
      (async () => {
        const anchors: string[] = [];
        await handlers!.compact({
          sessionID: sid,
          phase: "prepare",
          capture: false,
          transcript: undefined,
          appendSystem: (text) => anchors.push(text),
        });
        return (config.compaction ?? compactWithMemory)(event, ctx, anchors);
      })(),
    );
  });
  pi.on("session_compact_failed", async () => {
    compactions.clear();
  });
  pi.on("session_compact", async (_event, ctx) => {
    if (!active()) return;
    const sid = identity(ctx);
    const snapshot = compactions.get(sid);
    compactions.delete(sid);
    await track(
      (async () => {
        if (snapshot && !snapshot.signal.aborted)
          await capture.withBinding(sid, snapshot.binding, (transcript) =>
            handlers!.compact({
              sessionID: sid,
              phase: "prepare",
              transcript,
              captureStarted: capture.track,
            }),
          );
        await handlers!.compact({
          sessionID: sid,
          phase: "complete",
          transcript: undefined,
        });
      })(),
    );
  });
  for (const [name, toolName, description] of [
    [
      "repo-init",
      "memory_init",
      "Initialize this project's build and test memories",
    ],
    [
      "memory-report",
      "memory_status",
      "Show memory status and harness statistics",
    ],
    ["memory", "memory_status", "Show memory status and harness statistics"],
  ])
    pi.registerCommand(name, {
      description,
      async handler(args, ctx) {
        if (!active()) throw new Error("Pi memory is closed");
        const tool = tools.get(toolName)!;
        const result = await track(
          tool.execute(
            toolName === "memory_init"
              ? { force: /\bforce\b/i.test(args) }
              : {},
            { sessionID: identity(ctx), callID: randomUUID() },
          ),
        );
        pi.sendMessage(
          { customType: name, content: result.content, display: true },
          { triggerTurn: false },
        );
      },
    });
}

function sharedTool(name: string) {
  return name === "powershell" ? "shell" : name === "find" ? "glob" : name;
}

/** Pi's shells attest the exit in structuredContent, not details or display text. */
export function toolMetadata(
  event: Pick<ToolResultEvent, "toolName" | "structuredContent">,
): Record<string, unknown> {
  const result = event.structuredContent;
  if (
    (event.toolName !== "bash" && event.toolName !== "powershell") ||
    !result ||
    typeof result !== "object" ||
    !("exit_code" in result)
  )
    return {};
  const exit = result.exit_code;
  return typeof exit === "number" && Number.isFinite(exit)
    ? { exitCode: exit }
    : {};
}
