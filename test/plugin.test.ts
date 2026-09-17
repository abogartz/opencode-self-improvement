// Smoke test: the plugin factory is loadable and exposes the full surface.
// This is what "install from scratch as an opencode extension" depends on.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pluginDefault, { SelfImprovement } from "../index.ts";
import { resetState } from "../src/state.ts";

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "osi-plugin-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(join(root, "repo"), { recursive: true });
  resetState();
});

describe("plugin wiring", () => {
  test("default export is the factory and returns tools + hooks", async () => {
    expect(pluginDefault).toBe(SelfImprovement);
    const hooks = await SelfImprovement({
      directory: join(process.env.OPENCODE_MEMORY_DIR!, "..", "repo"),
    } as never);

    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(
      [
        "memory_evidence",
        "memory_forget",
        "memory_init",
        "memory_list",
        "memory_recall",
        "memory_remember",
        "memory_undo",
        "memory_update",
      ].sort(),
    );
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
    expect(typeof hooks["experimental.session.compacting"]).toBe("function");
  });
});
