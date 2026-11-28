import { decodeTranscript } from "./capture/transcript.ts";
import type { MemoryLifecycleHost } from "./host/lifecycle.ts";
import type { PluginCtx } from "./core/host.ts";
import {
  sessionIdentityEvent,
  sessionUsageEvent,
} from "./identity/host-events.ts";
import {
  observedToolResults,
  resultText,
  resultMeta,
  writePullIntoResult,
} from "./inject/host-delivery.ts";

const string = (value: unknown) =>
  typeof value === "string" ? value : undefined;

function appendSystem(event: any): ((text: string) => void) | undefined {
  const parts = event?.system;
  return typeof parts?.push === "function"
    ? (text) => {
        parts.push({ type: "text", text });
      }
    : undefined;
}

function modelRef(model: any) {
  const providerID = string(model?.providerID)?.trim();
  const id = string(model?.id)?.trim();
  return providerID && id ? { providerID, id } : undefined;
}

/** OpenCode owns payload translation, mutable delivery surfaces and subscriptions. */
export function createOpenCodeLifecycle(ctx: PluginCtx): MemoryLifecycleHost {
  return {
    async register(handlers) {
      const controller = new AbortController();
      const hooks: Array<{ dispose?: () => Promise<void> | void }> = [];
      let cleanup: Promise<void> | undefined;
      const registration = {
        dispose(): Promise<void> {
          if (cleanup) return cleanup;
          controller.abort();
          cleanup = (async () => {
            const results = await Promise.allSettled(
              hooks.reverse().map(async (hook) => hook.dispose?.()),
            );
            for (const result of results)
              if (result.status === "rejected") handlers.error(result.reason);
          })();
          return cleanup;
        },
      };
      const keep = (hook: { dispose?: () => Promise<void> | void } | void) => {
        if (hook) hooks.push(hook);
      };
      try {
        keep(
          await ctx.tool?.hook("execute.before", (raw: any) => {
            if (controller.signal.aborted) return;
            return handlers.beforeTool({
              sessionID: string(raw?.sessionID),
              callID: string(raw?.callID ?? raw?.id),
              tool: string(raw?.tool),
            });
          }),
        );
        keep(
          await ctx.tool?.hook("execute.after", (raw: any) => {
            if (controller.signal.aborted) return;
            const result = raw?.result;
            const text = resultText(result);
            return handlers.afterTool({
              sessionID: string(raw?.sessionID),
              callID: string(raw?.callID ?? raw?.id),
              tool: string(raw?.tool),
              args: raw?.input,
              text,
              metadata: resultMeta(result),
              appendResult: (after) => writePullIntoResult(result, text, after),
            });
          }),
        );
        keep(
          await ctx.session?.hook("context", (raw: any) => {
            if (controller.signal.aborted) return;
            const append = appendSystem(raw);
            return handlers.context({
              sessionID: string(raw?.sessionID),
              model: modelRef(raw?.model),
              observedResults: observedToolResults(raw?.messages),
              appendSystem: append,
            });
          }),
        );
        keep(
          await ctx.session?.hook("prompt", (raw: any) => {
            if (controller.signal.aborted) return;
            return handlers.prompt({
              sessionID: string(raw?.sessionID),
              text: string(raw?.prompt?.text) ?? "",
            });
          }),
        );
        keep(
          await ctx.session?.hook("compaction", (raw: any) => {
            if (controller.signal.aborted) return;
            const append = appendSystem(raw);
            return handlers.compact({
              sessionID: string(raw?.sessionID),
              transcript: decodeTranscript(raw?.messages),
              appendSystem: append,
            });
          }),
        );
      } catch (error) {
        await registration.dispose();
        throw error;
      }
      if (ctx.event?.subscribe) {
        const eventApi = ctx.event;
        void (async () => {
          try {
            for await (const raw of eventApi.subscribe({
              signal: controller.signal,
            })) {
              if (controller.signal.aborted) break;
              const identity = sessionIdentityEvent(raw);
              if (identity) {
                handlers.identity(identity);
                continue;
              }
              const usage = sessionUsageEvent(raw);
              if (usage) await handlers.usage(usage);
            }
          } catch (error) {
            if (!controller.signal.aborted) handlers.error(error);
          }
        })();
      }
      return registration;
    },
  };
}
