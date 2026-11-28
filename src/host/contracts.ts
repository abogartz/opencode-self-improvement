/** Identity normalized by the adapter before entering a memory tool. */
export interface ToolCallContext {
  readonly sessionID?: string;
  readonly callID?: string;
}

/** Host-neutral tools accept raw input; their schema validator owns parsing. */
export interface MemoryTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute(
    args: unknown,
    context?: ToolCallContext,
  ): Promise<{ content: string }>;
}

export interface MemoryToolEditor {
  add(tool: MemoryTool): void;
}

/**
 * Optional directory sources, ordered by the shared identity policy. Transcript
 * misses are retryable; the session record is a one-attempt fallback. A host
 * with only one source implements fromSession. Errors remain errors for the
 * caller to handle; an absent directory never means the process working tree.
 */
export interface SessionDirectories {
  fromTranscript?(sessionID: string): Promise<string | undefined>;
  fromSession?(sessionID: string): Promise<string | undefined>;
}

/** The tool/identity boundary; lifecycle and context delivery are separate. */
export interface MemoryToolHost {
  directories: SessionDirectories;
  registerTools(register: (editor: MemoryToolEditor) => void): Promise<void>;
}
