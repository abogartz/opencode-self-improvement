import type { MemoryHost } from "../../host/runtime.ts";
import type { PluginCtx } from "./context.ts";
import { createOpenCodeHost } from "./host.ts";
import { createOpenCodeLifecycle } from "./lifecycle.ts";
import { createOpenCodeCapture } from "./capture.ts";
import { ensureInitCommand, ensureMemoryReportCommand } from "./commands.ts";
import { openCodeCapabilities } from "./capabilities.ts";

/** Translate OpenCode services into the same ports used by every memory host. */
export function createOpenCodeMemoryHost(ctx: PluginCtx): MemoryHost {
  return {
    harness: "opencode",
    get capabilities() {
      return openCodeCapabilities(ctx);
    },
    tools: createOpenCodeHost(ctx),
    lifecycle: createOpenCodeLifecycle(ctx),
    // Hook registration may attach APIs, so inspect capture afterward.
    get capture() {
      return createOpenCodeCapture(ctx);
    },
    async installCommands() {
      await ensureInitCommand();
      await ensureMemoryReportCommand();
    },
  };
}
