import { expect, test } from "bun:test";
import plugin from "../../src/adapters/opencode/plugin.ts";
import type { PluginCtx } from "../../src/adapters/opencode/context.ts";
import { withTempStore } from "../harness.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";

withTempStore({ prefix: "osi-adapter-startup-" });

test("OpenCode discovers capture capabilities after hooks finish registering", async () => {
  const ctx: PluginCtx = {
    session: {
      async hook(name) {
        if (name !== "compaction") return;
        ctx.event = { async *subscribe() {} };
        ctx.generate = {
          async text() {
            return "[]";
          },
        };
        ctx.session!.context = async () => [];
      },
    },
  };
  const cleanup = await plugin.setup(ctx as never);
  try {
    const heartbeat = readEvidenceLog().find(
      (line) => line.ev === "plugin_load",
    );
    expect(heartbeat?.capture).toBe("on");
    expect(heartbeat?.capabilities).toBe(
      "[event.subscribe,generate.text,session.context]",
    );
  } finally {
    if (typeof cleanup === "function") await cleanup();
  }
});
