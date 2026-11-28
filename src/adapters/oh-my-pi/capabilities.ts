import type { HostCapabilities } from "../../host/capabilities.ts";

/** Surfaces implemented against the oh-my-pi extension API. */
export const ohMyPiCapabilities: Omit<HostCapabilities, "capture"> = {
  tools: true,
  identityEvents: true,
  usageReceipts: true,
  toolEvents: true,
  promptEvents: true,
  context: {
    system: true,
    toolResults: true,
    observedToolResults: true,
    promptDependentCache: "changes-conversation-prefix",
  },
  compaction: "split",
  // The host awaits shutdown handlers only within its two-second budget.
  shutdown: { cooperative: "best-effort", forcedExit: "no-cleanup" },
};
