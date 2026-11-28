import type { HostCapabilities } from "../../host/capabilities.ts";
import type { PluginCtx } from "./context.ts";

/** Inspect after registration: a host can attach APIs while installing hooks. */
export function openCodeCapabilities(
  ctx: PluginCtx,
): Omit<HostCapabilities, "capture"> {
  const sessionHooks = typeof ctx.session?.hook === "function";
  const toolHooks = typeof ctx.tool?.hook === "function";
  return {
    tools: typeof ctx.tool?.transform === "function",
    identityEvents: typeof ctx.event?.subscribe === "function",
    usageReceipts: typeof ctx.event?.subscribe === "function",
    toolEvents: toolHooks,
    promptEvents: sessionHooks,
    context: {
      system: sessionHooks,
      toolResults: toolHooks,
      observedToolResults: sessionHooks,
      promptDependentCache: sessionHooks
        ? "changes-conversation-prefix"
        : "unavailable",
    },
    compaction: sessionHooks ? "combined" : "unavailable",
    shutdown: { cooperative: "best-effort", forcedExit: "no-cleanup" },
  };
}
