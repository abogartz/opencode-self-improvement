import { describe } from "bun:test";
import { withTempStore } from "../helpers/temp-store.ts";
import { runtimeHostContract } from "../host/runtime-contract.ts";
import { openCodeRuntimeDriver } from "../adapters/runtime-driver.ts";

const store = withTempStore({ prefix: "osi-opencode-runtime-contract-" });
describe("OpenCode shared runtime contract", () => {
  runtimeHostContract(openCodeRuntimeDriver, store);
});
