/** Adapter declarations, not evidence that a particular request was delivered. */
export interface HostCapabilities {
  readonly tools: boolean;
  readonly identityEvents: boolean;
  readonly usageReceipts: boolean;
  readonly toolEvents: boolean;
  readonly promptEvents: boolean;
  readonly context: {
    readonly system: boolean;
    readonly toolResults: boolean;
    readonly observedToolResults: boolean;
    /** Effect of changing system context on the prefix before conversation text. */
    readonly promptDependentCache:
      | "changes-conversation-prefix"
      | "preserves-conversation-prefix"
      | "unknown"
      | "unavailable";
  };
  readonly compaction: "combined" | "split" | "unavailable";
  readonly capture: {
    readonly turnEnd: boolean;
    readonly transcript: boolean;
    readonly generation: boolean;
    readonly defaultModel: boolean;
  };
  readonly shutdown: {
    /** A returned cleanup promise alone does not establish that the host joins it. */
    readonly cooperative: "awaited" | "best-effort" | "unknown";
    readonly forcedExit: "no-cleanup" | "unknown";
  };
}
