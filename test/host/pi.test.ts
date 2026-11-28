import { describe, expect, test } from "bun:test";
import { toolMetadata } from "../../src/adapters/pi/runtime.ts";
import { sessionUsage } from "../../src/adapters/pi-family/usage.ts";
import { memoryOptions } from "../../src/adapters/pi-family/config.ts";
import { withTempStore } from "../helpers/temp-store.ts";
import { piRuntimeDriver } from "../adapters/pi-runtime-driver.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";

const store = withTempStore({ prefix: "osi-pi-boundary-" });
describe("Pi native normalization", () => {
  test("shell receipts require finite structured exits and exclude failed reads", () => {
    for (const toolName of ["bash", "powershell"])
      for (const exit of [0, 1, -1])
        expect(
          toolMetadata({ toolName, structuredContent: { exit_code: exit } }),
        ).toEqual({ exitCode: exit });
    for (const exit of ["1", null, NaN, Infinity])
      expect(
        toolMetadata({
          toolName: "bash",
          structuredContent: { exit_code: exit },
        }),
      ).toEqual({});
    expect(
      toolMetadata({ toolName: "read", structuredContent: { exit_code: 1 } }),
    ).toEqual({});
  });

  test("Pi reasoning receipts survive empty aborted assistants and retain partial errors", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          usage: {
            input: 11,
            cacheRead: 3,
            cacheWrite: 2,
            output: 7,
            reasoning: 2,
          },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "aborted",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    ];
    const ctx = {
      sessionManager: {
        getSessionId: () => "pi-session",
        getEntries: () => entries,
      },
    };
    expect(sessionUsage(ctx, "generation", "reasoning")).toMatchObject({
      accountingID: "pi-session",
      input: 11,
      output: 5,
      reasoning: 2,
    });
    entries.push({
      type: "message",
      message: {
        role: "assistant",
        stopReason: "aborted",
        usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
    });
    expect(sessionUsage(ctx, "generation", "reasoning")).toMatchObject({
      input: 16,
      output: 8,
      reasoning: undefined,
    });
  });

  test("configuration belongs to Pi rather than oh-my-pi", async () => {
    await Bun.write(
      `${store.memoryDir}/pi.json`,
      JSON.stringify({ autoCapture: false, injectBudget: 33 }),
    );
    await Bun.write(
      `${store.memoryDir}/oh-my-pi.json`,
      JSON.stringify({ injectBudget: 99 }),
    );
    expect(
      memoryOptions({}, { name: "pi", configEnv: "OSI_TEST_PI_CONFIG" }),
    ).toEqual({ autoCapture: false, injectBudget: 33 });
    expect(
      memoryOptions(
        { injectBudget: 44 },
        { name: "pi", configEnv: "OSI_TEST_PI_CONFIG" },
      ).injectBudget,
    ).toBe(44);
  });

  test("native find participates in the shared search evidence contract", async () => {
    const d = await piRuntimeDriver({
      directory: store.root,
      options: { autoCapture: false },
    });
    try {
      await d.emit("afterTool", {
        sessionID: "finder",
        callID: "find-1",
        tool: "find",
        args: { pattern: "*.ts" },
        text: "src/archive.ts",
        metadata: {},
        appendResult: () => true,
      });
      expect(readEvidenceLog().some((row) => row.tool === "glob")).toBe(true);
    } finally {
      await d.close();
    }
  });
});
