import { describe, expect, test } from "bun:test";
import { createOpenCodeHost } from "../../src/adapters/opencode/host.ts";
import type { MemoryTool, ToolCallContext } from "../../src/host/contracts.ts";
import type {
  PluginCtx,
  OpenCodeTool,
} from "../../src/adapters/opencode/context.ts";

describe("OpenCode tool and identity adapter", () => {
  test("registration preserves the wire schema and snapshots per-call identity synchronously", async () => {
    const registered: OpenCodeTool[] = [];
    const toolApi = {
      async transform(
        register: (editor: { add(tool: OpenCodeTool): void }) => void,
      ) {
        expect(this).toBe(toolApi);
        register({ add: (tool) => registered.push(tool) });
      },
      async hook() {},
    };
    const host = createOpenCodeHost({ tool: toolApi });
    const pending = Promise.withResolvers<void>();
    const seen: Array<ToolCallContext | undefined> = [];
    const args = { query: "azurite" };
    const coreTool: MemoryTool = {
      name: "memory_probe",
      description: "Probe the host boundary",
      input: { type: "object", properties: { query: { type: "string" } } },
      async execute(raw, context) {
        expect(raw).toBe(args);
        seen.push(context);
        await pending.promise;
        return { content: `${context?.sessionID}/${context?.callID}` };
      },
    };
    await host.registerTools((editor) => editor.add(coreTool));
    expect(registered).toHaveLength(1);
    const tool = registered[0]!;
    expect(tool.name).toBe(coreTool.name);
    expect(tool.description).toBe(coreTool.description);
    expect(tool.input).toEqual(coreTool.input);
    expect(tool.options).toEqual({ codemode: false });
    expect(coreTool).not.toHaveProperty("options");

    const context = { sessionID: "session-a", id: "call-a", callID: "wrong" };
    const first = tool.execute(args, context);
    expect(seen).toEqual([{ sessionID: "session-a", callID: "call-a" }]);
    context.sessionID = "session-b";
    context.id = "call-b";
    const second = tool.execute(args, context);
    pending.resolve();
    expect(await Promise.all([first, second])).toEqual([
      { content: "session-a/call-a" },
      { content: "session-b/call-b" },
    ]);
  });

  test("directory lookups preserve receivers and observe replaced host APIs", async () => {
    const first = {
      async hook() {},
      async context(input: { sessionID: string }) {
        expect(this).toBe(first);
        expect(input).toEqual({ sessionID: "s" });
        return [{ info: { location: { directory: "/messages" } } }];
      },
      async get(input: { sessionID: string }) {
        expect(this).toBe(first);
        expect(input).toEqual({ sessionID: "s" });
        return { data: { location: { directory: "/row" } } };
      },
    };
    const ctx: PluginCtx = { session: first };
    const host = createOpenCodeHost(ctx);
    expect(await host.directories.fromTranscript?.("s")).toBe("/messages");
    expect(await host.directories.fromSession?.("s")).toBe("/row");
    const replacement = {
      async hook() {},
      async get() {
        expect(this).toBe(replacement);
        return { directory: "/replacement" };
      },
    };
    ctx.session = replacement;
    expect(await host.directories.fromTranscript?.("s")).toBeUndefined();
    expect(await host.directories.fromSession?.("s")).toBe("/replacement");
  });

  test("missing APIs and malformed responses leave directory identity unresolved", async () => {
    const ctx: PluginCtx = {};
    const host = createOpenCodeHost(ctx);
    let registered = false;
    await host.registerTools(() => {
      registered = true;
    });
    expect(registered).toBe(false);
    expect(await host.directories.fromTranscript?.("s")).toBeUndefined();
    expect(await host.directories.fromSession?.("s")).toBeUndefined();
    ctx.session = {
      async hook() {},
      async context() {
        return [{ location: { directory: 42 } }];
      },
      async get() {
        return { data: {}, directory: "/must-not-bind" };
      },
    };
    expect(await host.directories.fromTranscript?.("s")).toBeUndefined();
    expect(await host.directories.fromSession?.("s")).toBeUndefined();
  });

  test("lookup and registration failures reach the caller without fabricated success", async () => {
    const failure = new Error("host unavailable");
    const host = createOpenCodeHost({
      session: {
        async hook() {},
        async get() {
          throw failure;
        },
      },
      tool: {
        async hook() {},
        async transform() {
          throw failure;
        },
      },
    });
    await expect(host.directories.fromSession!("s")).rejects.toBe(failure);
    await expect(host.registerTools(() => {})).rejects.toBe(failure);
  });
});
