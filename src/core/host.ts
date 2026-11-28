import type { HostCapabilities } from "../host/capabilities.ts";

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

// Structural subset of the OpenCode host used by setup and hook wiring.
export interface OpenCodeTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options?: { codemode?: boolean; namespace?: string };
  execute: (args: any, context: any) => Promise<{ content: string }>;
}
interface ToolEditorLike {
  add: (tool: OpenCodeTool) => void;
}
interface HookReg {
  dispose?: () => Promise<void> | void;
}
export interface PluginCtx {
  location?: { directory?: string };
  options?: Record<string, unknown>;
  tool?: {
    transform: (cb: (editor: ToolEditorLike) => void) => Promise<unknown>;
    hook: (
      name: string,
      cb: (event: any) => Promise<void> | void,
    ) => Promise<HookReg | void>;
  };
  session?: {
    hook: (
      name: string,
      cb: (event: any) => Promise<void> | void,
    ) => Promise<HookReg | void>;
    context?: (input: { sessionID: string }) => Promise<unknown>;
    get?: (input: { sessionID: string }) => Promise<unknown>;
  };
  event?: {
    subscribe: (o?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  };
  model?: {
    default?: {
      get?: () => { providerID: string; modelID: string } | undefined;
    };
  };
  generate?: {
    text: (input: unknown) => Promise<{ text?: string } | string>;
  };
}

import type { MemoryToolHost } from "../host/contracts.ts";

export function createOpenCodeHost(ctx: PluginCtx): MemoryToolHost {
  return {
    directories: {
      async fromTranscript(sessionID) {
        return sessionDirectoryFromMessages(
          await ctx.session?.context?.({ sessionID }),
        );
      },
      async fromSession(sessionID) {
        return sessionDirectoryFromRow(await ctx.session?.get?.({ sessionID }));
      },
    },
    async registerTools(register) {
      // Read APIs at call time and retain their receiver. Hosts can attach or
      // replace session APIs after setup, including on service instances.
      await ctx.tool?.transform((editor) => {
        register({
          add(tool) {
            editor.add({
              ...tool,
              options: { codemode: false },
              execute(args, context) {
                // No await before the shared tool captures caller identity.
                return tool.execute(args, toolIdentity(context));
              },
            });
          },
        });
      });
    },
  };
}

import type { ToolCallContext } from "../host/contracts.ts";

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** V2 ToolContext uses id for the call; missing fields retain the legacy fallback. */
export function toolIdentity(context: unknown): ToolCallContext {
  const { sessionID, id } = fields(context);
  return {
    sessionID:
      typeof sessionID === "string" && sessionID ? sessionID : undefined,
    callID: typeof id === "string" && id ? id : undefined,
  };
}

/** Legacy context messages sometimes carry location directly or inside info. */
export function sessionDirectoryFromMessages(
  messages: unknown,
): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    const row = fields(message);
    const directory =
      fields(row.location).directory ??
      fields(fields(row.info).location).directory;
    if (typeof directory === "string" && directory) return directory;
  }
  return undefined;
}

/** session.get returns either a row or a {data: row} response. */
export function sessionDirectoryFromRow(result: unknown): string | undefined {
  const response = fields(result);
  const row = fields(response.data ?? response);
  const directory = fields(row.location).directory ?? row.directory;
  return typeof directory === "string" && directory ? directory : undefined;
}
