// Developed and integration-tested against oh-my-pi 19.2.1 with Bun 1.4.4.
// The matching pi-coding-agent, pi-ai and pi-catalog releases are pinned in
// integration/oh-my-pi/package.json and its lockfile. Re-run test:oh-my-pi
// when changing that baseline; other releases and upstream Pi require their
// own compatibility verification.
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { LifecycleHandlers } from "../../host/lifecycle.ts";
import type { MemoryRuntime } from "../../host/runtime.ts";
import { setupMemory } from "../../runtime/setup.ts";
import type {
  OmpAPI,
  OmpContent,
  OmpContext,
  OmpEvents,
  OmpEventResult,
} from "./context.ts";
import { createOhMyPiCapture, type OmpCaptureBinding } from "./capture.ts";
import { appendPull, observedToolResults, textContent } from "./delivery.ts";
import { sessionUsage } from "./usage.ts";
import { bindCompletion } from "./completion.ts";
import { memoryOptions } from "./config.ts";
import { ohMyPiCapabilities } from "./capabilities.ts";
import type { MemoryTool } from "../../host/contracts.ts";

export function createOhMyPiMemory<C extends OmpContext = OmpContext>(
  config: {
    capture?: (ctx: C) => OmpCaptureBinding | undefined;
    options?: Record<string, unknown>;
  } = {},
) {
  return async function ohMyPiMemory(pi: OmpAPI<C>): Promise<void> {
    const options = memoryOptions(config.options);
    const tools = new Map<string, MemoryTool>();
    const capture = createOhMyPiCapture();
    const compactions = new Map<
      string,
      { binding: OmpCaptureBinding; signal: AbortSignal }
    >();
    const namespace = `oh-my-pi:${randomUUID()}:`;
    const pending = new Set<Promise<unknown>>();
    const initialized = Promise.withResolvers<void>();
    let generation = 0;
    let handlers: LifecycleHandlers | undefined;
    let runtime: MemoryRuntime | undefined;
    let closed = false;

    function track<T>(work: Promise<T>): Promise<T> {
      pending.add(work);
      work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    }

    function identity(ctx: OmpContext): string {
      const id = ctx.sessionManager.getSessionId();
      if (!id?.trim() || !ctx.cwd?.trim() || !isAbsolute(ctx.cwd)) {
        throw new Error(
          "oh-my-pi memory requires a session and absolute workspace identity",
        );
      }
      const sessionID = `${namespace}${generation}:${id}`;
      handlers!.identity({ sessionID, directory: ctx.cwd });
      return sessionID;
    }

    function on<K extends keyof OmpEvents>(
      name: K,
      run: (
        event: OmpEvents[K],
        sessionID: string,
        ctx: C,
      ) => Promise<OmpEventResult<K>>,
    ): void {
      pi.on(name, async (event, ctx) => {
        if (closed || !handlers) return;
        // Capture identity before awaiting: other sessions may run in the meantime.
        const sessionID = identity(ctx);
        return track(run(event, sessionID, ctx));
      });
    }

    async function reportUsage(sessionID: string, ctx: C): Promise<void> {
      const usage = sessionUsage(ctx, sessionID);
      if (usage) await handlers!.usage(usage);
    }

    pi.on("session_shutdown", async (_event, ctx) => {
      // Capture the history and identity before shutdown can replace host state.
      if (!closed && handlers) {
        try {
          track(reportUsage(identity(ctx), ctx));
        } catch {
          // A host may have already discarded identity; cleanup must still run.
        }
      }
      closed = true;
      compactions.clear();
      await initialized.promise;
      // Leave room for the shared write drain within the host's two-second cap.
      if (!config.capture) await capture.settle(500);
      await runtime?.dispose();
    });

    try {
      runtime = await setupMemory(
        {
          harness: "oh-my-pi",
          capabilities: ohMyPiCapabilities,
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
                    loadMode: "essential",
                    async execute(callID, args, signal, _onUpdate, ctx) {
                      if (closed || !handlers)
                        throw new Error("oh-my-pi memory is closed");
                      signal?.throwIfAborted();
                      const sessionID = identity(ctx);
                      const result = await track(
                        tool.execute(args, { sessionID, callID }),
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
              on("session_start", async (_event, sessionID, ctx) => {
                await reportUsage(sessionID, ctx);
              });
              on("agent_end", async (event, sessionID, ctx) => {
                const binding =
                  !event.willContinue &&
                  !event.awaitingAsyncWork &&
                  options.autoCapture !== false
                    ? config.capture
                      ? config.capture(ctx)
                      : bindCompletion(
                          ctx,
                          event.messages,
                          options.captureModel,
                        )
                    : undefined;
                const captured = binding
                  ? capture.publish(sessionID, binding)
                  : undefined;
                await reportUsage(sessionID, ctx);
                await captured;
              });
              for (const name of [
                "session_switch",
                "session_clear",
                "session_tree",
                "session_branch",
              ] as const) {
                pi.on(name, async (_event, ctx) => {
                  if (closed) return;
                  // Transcript replacement can retain the host ID. Old grounding
                  // and frozen context must not become evidence in the new view.
                  generation++;
                  compactions.clear();
                  await track(reportUsage(identity(ctx), ctx));
                });
              }
              on("before_agent_start", async (event, sessionID) => {
                if (event.reason === "revive") return;
                compactions.clear();
                const systemPrompt = [...event.systemPrompt];
                await shared.prompt({ sessionID, text: event.prompt });
                await shared.context({
                  sessionID,
                  observedResults: [],
                  appendSystem: (text) => systemPrompt.push(text),
                });
                return { systemPrompt };
              });
              on("tool_call", async (event, sessionID) => {
                await shared.beforeTool({
                  sessionID,
                  callID: event.toolCallId,
                  tool: event.toolName,
                });
              });
              on("context", async (event, sessionID) => {
                await shared.context({
                  sessionID,
                  observedResults: observedToolResults(event.messages),
                });
              });
              on("tool_result", async (event, sessionID) => {
                const metadata =
                  event.details && typeof event.details === "object"
                    ? (event.details as Record<string, unknown>)
                    : {};
                // A reported nonzero shell exit is real gate evidence. Other
                // errors may mean the tool never ran and cannot ground a write.
                const failedCommand =
                  (event.toolName === "bash" || event.toolName === "shell") &&
                  typeof metadata.exitCode === "number" &&
                  Number.isFinite(metadata.exitCode) &&
                  metadata.exitCode !== 0;
                if (event.isError && !failedCommand) return;
                const text = textContent(event.content);
                let content: OmpContent[] | undefined;
                await shared.afterTool({
                  sessionID,
                  callID: event.toolCallId,
                  tool: event.toolName,
                  args: event.input,
                  text,
                  metadata,
                  appendResult: (after) => {
                    if (event.isError || failedCommand) return false;
                    content = appendPull(event.content, text, after);
                    return content !== undefined;
                  },
                });
                if (content) return { content };
              });
              if (
                options.autoCapture !== false &&
                options.captureOnCompact !== false
              )
                on("session_before_compact", async (event, sessionID, ctx) => {
                  compactions.clear();
                  if (event.signal.aborted) return;
                  const messages = [
                    ...event.preparation.messagesToSummarize,
                    ...event.preparation.turnPrefixMessages,
                  ];
                  const binding = config.capture
                    ? config.capture(ctx)
                    : bindCompletion(ctx, messages, options.captureModel);
                  if (binding)
                    compactions.set(sessionID, {
                      binding,
                      signal: event.signal,
                    });
                });
              on("session.compacting", async (event, sessionID, ctx) => {
                if (event.sessionId !== ctx.sessionManager.getSessionId())
                  return;
                const context: string[] = [];
                await shared.compact({
                  sessionID,
                  phase: "prepare",
                  capture: false,
                  transcript: undefined,
                  appendSystem: (text) => context.push(text),
                });
                if (context.length) return { context };
              });
              on("session_compact", async (_event, sessionID) => {
                const snapshot = compactions.get(sessionID);
                compactions.delete(sessionID);
                // Mine the saved pre-compaction text only after the host commits;
                // cancelled preparations must not start model work.
                if (snapshot && !snapshot.signal.aborted)
                  await capture.withBinding(
                    sessionID,
                    snapshot.binding,
                    (transcript) =>
                      shared.compact({
                        sessionID,
                        phase: "prepare",
                        transcript,
                        captureStarted: capture.track,
                      }),
                  );
                await shared.compact({
                  sessionID,
                  phase: "complete",
                  transcript: undefined,
                });
              });
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
          },
        },
      );
      if (pi.registerCommand && pi.sendMessage) {
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
        ]) {
          pi.registerCommand(name, {
            description,
            async handler(args, ctx) {
              if (closed || !handlers)
                throw new Error("oh-my-pi memory is closed");
              const sessionID = identity(ctx);
              const tool = tools.get(toolName);
              if (!tool) throw new Error("Memory command is unavailable");
              const result = await track(
                tool.execute(
                  toolName === "memory_init"
                    ? { force: /\bforce\b/i.test(args) }
                    : {},
                  { sessionID, callID: randomUUID() },
                ),
              );
              pi.sendMessage?.(
                { customType: name, content: result.content, display: true },
                { triggerTurn: false },
              );
            },
          });
        }
      }
      // Shutdown may arrive while startup diagnostics are still being written.
      if (closed) await runtime.dispose();
    } catch (error) {
      closed = true;
      capture.close();
      await Promise.allSettled([...pending]);
      throw error;
    } finally {
      initialized.resolve();
    }
  };
}

/** Normal host entry point, including capture through the host's model SDK. */
export default createOhMyPiMemory();
