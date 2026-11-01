// Shared dependency surface for the memory tools (#168). The tools module is
// a leaf: host wiring stays in index.ts and arrives through this interface,
// so a tool file never reaches into the plugin setup closure.
import type { GateContext } from "../gates.ts";
import type { createInjectionEpochs } from "../injection-epochs.ts";
import type { HitSource } from "../hits.ts";
import type { Memory } from "../memory.ts";

export interface ToolDeps {
  toolIds: (context?: unknown) => { sid: string; call: string };
  bindSessionIdentity: (sid: string | undefined) => Promise<void>;
  ownerlessWriter: (sid: string | undefined) => string | null;
  refuseOwnerlessWrite: (sid: string, op: string) => Promise<{ content: string }>;
  gateContext: (sid?: string) => GateContext;
  sessions: ReturnType<typeof createInjectionEpochs>;
  noteHits: (src: HitSource, sid: string, rows: Memory[], query: string) => Promise<void>;
  direct: { readonly codemode: false };
}

// Structural twin of the host's tool editor; `any` mirrors the loose host
// interop types index.ts already uses for the plugin surface.
export interface ToolEditorLike {
  // biome-ignore lint/suspicious/noExplicitAny: host interop boundary
  add: (tool: any) => void;
}

export type ToolRegister = (editor: ToolEditorLike, deps: ToolDeps) => void;
