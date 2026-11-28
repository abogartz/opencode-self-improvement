// Shared dependency surface for the memory tools. The tools module is
// a leaf: host wiring stays in index.ts and arrives through this interface,
// so a tool file never reaches into the plugin setup closure.
import type { GateContext } from "../gate/gate.ts";
import type { createInjectionEpochs } from "../inject/epochs.ts";
import type { HitSource } from "../telemetry/ledger.ts";
import type { Memory } from "../store/model/memory.ts";
import type { MemoryToolEditor, ToolCallContext } from "../host/contracts.ts";

export interface ToolDeps {
  toolIds: (context?: ToolCallContext) => { sid: string; call: string };
  bindSessionIdentity: (sid: string | undefined) => Promise<void>;
  ownerlessWriter: (sid: string | undefined) => string | null;
  refuseOwnerlessWrite: (
    sid: string,
    op: string,
  ) => Promise<{ content: string }>;
  gateContext: (sid?: string) => GateContext;
  sessions: ReturnType<typeof createInjectionEpochs>;
  noteHits: (
    src: HitSource,
    sid: string,
    rows: Memory[],
    query: string,
  ) => Promise<void>;
}

export type ToolEditorLike = MemoryToolEditor;

export type ToolRegister = (editor: ToolEditorLike, deps: ToolDeps) => void;
