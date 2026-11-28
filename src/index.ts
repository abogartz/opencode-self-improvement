import type { MemoryHost } from "./host/runtime.ts";
import type { PluginCtx } from "./core/host.ts";
import { createOpenCodeHost } from "./core/host.ts";
import { createOpenCodeLifecycle } from "./events.ts";
import { createOpenCodeCapture } from "./capture/runtime.ts";
import { ensureInitCommand, ensureMemoryReportCommand } from "./init/ensure.ts";
import { openCodeCapabilities } from "./core/host.ts";

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

import type { Plugin } from "@opencode/plugin/promise/plugin";

import { setupMemory } from "./runtime/setup.ts";

// Type-only SDK import: published installs have runtime dependencies only.
const plugin: Plugin = {
  id: "opencode-self-improvement",
  async setup(raw) {
    const ctx = raw as unknown as PluginCtx;
    const runtime = await setupMemory(createOpenCodeMemoryHost(ctx), {
      directory: ctx.location?.directory,
      options: ctx.options,
    });
    return () => runtime.dispose();
  },
};

export const SelfImprovement = plugin;
export default plugin;

// Preserve the OpenCode entry point while shared initialization lives independently.

export { resetCaptureCooldowns } from "./runtime/capture.ts";
export { resetSessionModels } from "./capture/session-model.ts";
export {
  TURN_END_EVENTS,
  CAPTURE_EVENT_TYPES,
  captureTriggerFor,
} from "./capture/runtime.ts";
