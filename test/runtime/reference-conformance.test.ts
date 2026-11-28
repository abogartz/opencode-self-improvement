import { describe } from "bun:test";
import { withTempStore } from "../helpers/temp-store.ts";
import { runtimeHostContract } from "../host/runtime-contract.ts";
import { TestHost } from "../simulator/host.ts";

const store = withTempStore({ prefix: "osi-reference-contract-" });
describe("Reference shared runtime contract", () => {
  runtimeHostContract(async (config) => {
    const host = new TestHost("reference", config);
    await host.start();
    return host;
  }, store);
});
