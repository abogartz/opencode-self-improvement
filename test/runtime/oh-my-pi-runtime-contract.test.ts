import { describe } from "bun:test";
import { withTempStore } from "../helpers/temp-store.ts";
import { runtimeHostContract } from "../host/runtime-contract.ts";
import { ohMyPiRuntimeDriver } from "../adapters/oh-my-pi-runtime-driver.ts";

const store = withTempStore({ prefix: "osi-omp-runtime-contract-" });
describe("oh-my-pi shared runtime contract", () => {
  runtimeHostContract(ohMyPiRuntimeDriver, store, {
    promptDelivery: "combined",
  });
});
