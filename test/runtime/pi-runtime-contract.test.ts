import { describe } from "bun:test";
import { withTempStore } from "../helpers/temp-store.ts";
import { runtimeHostContract } from "../host/runtime-contract.ts";
import { piRuntimeDriver } from "../adapters/pi-runtime-driver.ts";

const store = withTempStore({ prefix: "osi-pi-runtime-contract-" });
describe("pi shared runtime contract", () => {
  runtimeHostContract(piRuntimeDriver, store, {
    promptDelivery: "combined",
  });
});
