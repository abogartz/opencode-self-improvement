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
      name: "execute.before" | "execute.after",
      cb: (event: any) => Promise<void> | void,
    ) => Promise<HookReg | void>;
  };
  session?: {
    hook: (
      name: "context" | "prompt" | "compaction",
      cb: (event: any) => Promise<void> | void,
    ) => Promise<HookReg | void>;
    context?: (input: { sessionID: string }) => Promise<unknown>;
    get?: (input: { sessionID: string }) => Promise<unknown>;
  };
  event?: {
    subscribe: (o?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  };
  model?: {
    default?:
      | {
          get?: () => { providerID: string; modelID: string } | undefined;
        }
      | ((input?: { location?: { directory?: string } }) => Promise<{
          data: { providerID: string; modelID: string } | null;
        }>);
  };
  generate?: {
    text: (
      input: { prompt: string; model: { providerID: string; id: string } },
      options?: { signal?: AbortSignal },
    ) => Promise<{ text?: string } | string>;
  };
}
