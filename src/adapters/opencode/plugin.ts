import type { Plugin } from "@opencode/plugin/promise/plugin";
import type { PluginCtx } from "./context.ts";
import { createOpenCodeMemoryHost } from "./memory-host.ts";
import { setupMemory } from "../../runtime/setup.ts";

// Type-only SDK import: published installs have runtime dependencies only.
const plugin: Plugin = {
  id: "opencode-self-improvement",
  async setup(raw) {
    const ctx: PluginCtx = raw;
    const runtime = await setupMemory(createOpenCodeMemoryHost(ctx), {
      directory: ctx.location?.directory,
      options: ctx.options,
    });
    return () => runtime.dispose();
  },
};

export const SelfImprovement = plugin;
export default plugin;
