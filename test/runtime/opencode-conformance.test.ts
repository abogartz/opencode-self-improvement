import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createOpenCodeMemoryHost } from "../../src/adapters/opencode/memory-host.ts";
import type {
  OpenCodeTool,
  PluginCtx,
} from "../../src/adapters/opencode/context.ts";
import type { MemoryHost } from "../../src/host/runtime.ts";
import { setupMemory } from "../../src/runtime/setup.ts";
import { withTempStore } from "../helpers/temp-store.ts";
import { TestHost } from "../simulator/host.ts";

const store = withTempStore({ prefix: "osi-opencode-contract-" });
const FACT =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";

interface Driver {
  host: MemoryHost;
  size(): number;
  ground(sid: string): Promise<void>;
  invoke(
    sid: string,
    name: string,
    args: unknown,
  ): Promise<{ content: string }>;
  request(sid: string, text: string): Promise<string>;
}

function openCode(directory: string): Driver {
  const tools = new Map<string, OpenCodeTool>();
  const hooks = new Map<string, (event: any) => void | Promise<void>>();
  const hook = async (
    name: string,
    cb: (event: any) => void | Promise<void>,
  ) => {
    hooks.set(name, cb);
    return {
      dispose() {
        hooks.delete(name);
      },
    };
  };
  const ctx: PluginCtx = {
    tool: {
      hook,
      async transform(edit) {
        edit({
          add: (tool) => {
            tools.set(tool.name, tool);
          },
        });
      },
    },
    session: {
      hook,
      async get() {
        return { directory };
      },
    },
  };
  let calls = 0;
  return {
    host: createOpenCodeMemoryHost(ctx),
    size: () => tools.size,
    async ground(sessionID) {
      await hooks.get("execute.after")?.({
        sessionID,
        callID: `${sessionID}-read`,
        tool: "read",
        input: {},
        result: { content: "observed" },
      });
    },
    async invoke(sessionID, name, args) {
      return tools
        .get(name)!
        .execute(args, { sessionID, callID: `${sessionID}-${++calls}` });
    },
    async request(sessionID, text) {
      await hooks.get("prompt")?.({ sessionID, prompt: { text } });
      const system: Array<{ type: string; text: string }> = [];
      await hooks.get("context")?.({ sessionID, system, messages: [] });
      return system.map((part) => part.text).join("\n");
    },
  };
}

function simulator(directory: string): Driver {
  const host = new TestHost("conformance", { directory });
  return {
    host: host.host,
    size: () => host.tools.size,
    ground: (sid) => host.ground(sid),
    invoke: (sid, name, args) => host.invoke(sid, name, args),
    request: (sid, text) => host.request(sid, text),
  };
}

for (const [name, writerFactory, readerFactory] of [
  ["OpenCode to simulator", openCode, simulator],
  ["simulator to OpenCode", simulator, openCode],
] as const) {
  test(`${name}: the same runtime enforces gates and shares selected memories`, async () => {
    const directory = join(store.root, "project");
    mkdirSync(directory);
    const writer = writerFactory(directory);
    const reader = readerFactory(directory);
    const config = { directory, options: { autoCapture: false } };
    const a = await setupMemory(writer.host, config);
    const b = await setupMemory(reader.host, config);
    try {
      expect(writer.size()).toBe(14);
      expect(reader.size()).toBe(14);
      const args = {
        type: "learning",
        scope: "azurite",
        status: "settled",
        content: FACT,
      };
      expect(
        (await writer.invoke("writer", "memory_remember", args)).content,
      ).toInclude("Write blocked at GATE");
      await writer.ground("writer");
      expect(
        (await writer.invoke("writer", "memory_remember", args)).content,
      ).toStartWith("Remembered:");
      expect(
        (
          await reader.invoke("reader", "memory_recall", {
            query: "azurite stale manifest",
          })
        ).content,
      ).toInclude(FACT);
      expect(
        await reader.request("relevant", "azurite deployment stale manifest"),
      ).toInclude(FACT);
      expect(
        await reader.request("unrelated", "penguin migration"),
      ).not.toInclude(FACT);
      expect(b.capabilities.tools).toBe(true);
      const closing = b.dispose();
      expect(b.dispose()).toBe(closing);
      await closing;
      expect(
        await reader.request("closed", "azurite deployment stale manifest"),
      ).toBe("");
    } finally {
      await Promise.all([a.dispose(), b.dispose()]);
    }
  });
}
