import { describe } from "bun:test";
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
