import type { SessionModelRef } from "../capture/session-model.ts";

/** Public conversation text only; a blank slot preserves the transcript cursor. */
export interface CaptureMessage {
  readonly role?: "user" | "assistant";
  readonly text: string;
  readonly timestamp?: number;
}

/** One slot per source message, including empty and non-conversation records. */
export type CaptureTranscript = readonly CaptureMessage[];
export type CompactCapture = (
  sessionID: string,
  transcript: CaptureTranscript | undefined,
) => Promise<void> | undefined;

export interface CaptureTurnEnd {
  /** Missing identity is observable, but must never start capture. */
  readonly sessionID?: string;
}

export interface MemoryCaptureHost {
  /** Diagnostic names of the host events, not shared dispatch vocabulary. */
  readonly subscribedEvents: readonly string[];
  /** Optional diagnostic labels only; capabilities come from the methods below. */
  readonly capabilityLabels?: Partial<
    Record<"turnEndEvents" | "generateText" | "readTranscript", string>
  >;
  turnEndEvents?: (signal: AbortSignal) => AsyncIterable<CaptureTurnEnd>;
  readTranscript?: (
    sessionID: string,
  ) => Promise<CaptureTranscript | undefined>;
  /** Resolves with the answer; no post-answer work belongs in the adapter. */
  generateText?: (input: {
    sessionID: string;
    model: SessionModelRef;
    prompt: string;
    signal: AbortSignal;
  }) => Promise<string>;
  /** Token-free lookup; some hosts resolve their configured default asynchronously. */
  defaultModel?: (
    sessionID?: string,
  ) => SessionModelRef | null | Promise<SessionModelRef | null>;
}
