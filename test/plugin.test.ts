// Smoke test: the plugin factory is loadable and exposes the full surface.
// This is what "install from scratch as an opencode extension" depends on.
import { beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pluginDefault, { SelfImprovement } from "../index.ts";
import { memoryRoot } from "../src/config.ts";
import { formatLine } from "../src/logfmt.ts";
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
        "memory_merge_review",
        "memory_recall",
        "memory_remember",
        "memory_undo",
        "memory_update",
      ].sort(),
    );
    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["chat.message"]).toBe("function");
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
    expect(typeof hooks["experimental.session.compacting"]).toBe("function");
  });

  test("chat.message pushes a schema-valid synthetic part for a matching message", async () => {
    const mem = join(memoryRoot(), "2026-09-18.logfmt");
    mkdirSync(memoryRoot(), { recursive: true });
    appendFileSync(
      mem,
      formatLine({
        ts: new Date().toISOString(),
        type: "pattern",
        scope: "Babylon.js",
        content: "Run Babylon.js unit tests with npx vitest run from the repo root.",
      }) + "\n",
    );
    const hooks = await SelfImprovement({
      directory: join(process.env.OPENCODE_MEMORY_DIR!, "..", "repo"),
    } as never);

    const parts = [{ type: "text", id: "prt_user", sessionID: "ses_x", messageID: "msg_1", text: "run the unit test for multiTexture" }] as never[];
    const output = {
      message: { id: "msg_new" },
      parts,
    } as never;
    await hooks["chat.message"]!(
      { sessionID: "ses_x", messageID: undefined },
      output,
    );

    const injected = (output as unknown as { parts: { type: string; synthetic?: boolean; text: string; id: string; messageID: string }[] }).parts.find(
      (p) => p.type === "text" && p.synthetic,
    );
    expect(injected).toBeTruthy();
    expect(injected!.text).toContain("npx vitest run");
    expect(injected!.id).toMatch(/^prt_/);
    expect(injected!.messageID).toBe("msg_new");
  });

  test("chat.message fails closed (no crash, no push) when the message id is unavailable", async () => {
    const hooks = await SelfImprovement({
      directory: join(process.env.OPENCODE_MEMORY_DIR!, "..", "repo"),
    } as never);
    const parts = [{ type: "text", id: "prt_user", sessionID: "ses_x", messageID: "msg_1", text: "run the unit test" }] as never[];
    const output = { message: { id: "ses_no-msg-id" }, parts } as never;
    await expect(
      hooks["chat.message"]!.call(hooks, { sessionID: "ses_x", messageID: undefined }, output),
    ).resolves.toBeUndefined();
    expect((output as unknown as { parts: unknown[] }).parts.length).toBe(1);
  });
});
