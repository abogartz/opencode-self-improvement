import { describe } from "bun:test";
import { createOpenCodeHost } from "../../src/adapters/opencode/host.ts";
import type { OpenCodeTool } from "../../src/adapters/opencode/context.ts";
import type { MemoryTool } from "../../src/host/contracts.ts";
import { withTempStore } from "../harness.ts";
import { toolHostContract } from "./tool-contract.ts";

const store = withTempStore({ prefix: "osi-tool-host-contract-" });

describe("normalized in-memory host contract", () => {
  toolHostContract((directory) => {
    const tools = new Map<string, MemoryTool>();
    return {
      host: {
        directories: { fromSession: async () => directory },
        async registerTools(register) {
          register({
            add: (tool) => {
              tools.set(tool.name, tool);
            },
          });
        },
      },
      invoke: (name, args, context) => tools.get(name)!.execute(args, context),
    };
  }, store);
});

describe("OpenCode adapter contract", () => {
  toolHostContract((directory) => {
    const tools = new Map<string, OpenCodeTool>();
    const host = createOpenCodeHost({
      tool: {
        async hook() {},
        async transform(register) {
          register({
            add: (tool) => {
              tools.set(tool.name, tool);
            },
          });
        },
      },
      session: {
        async hook() {},
        async get() {
          return { location: { directory } };
        },
      },
    });
    return {
      host,
      invoke: (name, args, context) =>
        tools.get(name)!.execute(args, {
          sessionID: context.sessionID,
          id: context.callID,
        }),
    };
  }, store);
});
