import type { HostCapabilities } from "../../host/capabilities.ts";

export const piCapabilities: Omit<HostCapabilities, "capture"> = {
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
  shutdown: { cooperative: "awaited", forcedExit: "no-cleanup" },
};
