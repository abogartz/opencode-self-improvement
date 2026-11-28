import { expect, test } from "bun:test";
import { openCodeCapabilities } from "../../src/adapters/opencode/capabilities.ts";
import type { PluginCtx } from "../../src/adapters/opencode/context.ts";

test("OpenCode's offered surfaces follow the attached APIs without inventing cache or exit guarantees", () => {
  const ctx: PluginCtx = {};
  const absent = openCodeCapabilities(ctx);
  expect(absent.tools).toBe(false);
  expect(absent.context.system).toBe(false);
  expect(absent.context.promptDependentCache).toBe("unavailable");
  expect(absent.compaction).toBe("unavailable");
  expect(absent.usageReceipts).toBe(false);
  ctx.session = { async hook() {} };
  ctx.tool = { async hook() {}, async transform() {} };
  ctx.event = { async *subscribe() {} };
  const available = openCodeCapabilities(ctx);
  expect(available.tools).toBe(true);
  expect(available.context.system).toBe(true);
  expect(available.context.toolResults).toBe(true);
  expect(available.context.observedToolResults).toBe(true);
  expect(available.usageReceipts).toBe(true);
  expect(available.context.promptDependentCache).toBe(
    "changes-conversation-prefix",
  );
  expect(available.shutdown).toEqual({
    cooperative: "best-effort",
    forcedExit: "no-cleanup",
  });
});
