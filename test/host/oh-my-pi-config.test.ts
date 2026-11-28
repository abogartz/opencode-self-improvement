import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryOptions } from "../../src/adapters/oh-my-pi/config.ts";
import { withTempStore } from "../helpers/temp-store.ts";

const store = withTempStore({ prefix: "osi-omp-options-" });
const original = process.env.OMP_MEMORY_CONFIG;
afterEach(() => {
  if (original === undefined) delete process.env.OMP_MEMORY_CONFIG;
  else process.env.OMP_MEMORY_CONFIG = original;
});

test("the normal entry reads persistent options and explicit bindings override them", () => {
  delete process.env.OMP_MEMORY_CONFIG;
  mkdirSync(store.memoryDir);
  writeFileSync(
    join(store.memoryDir, "oh-my-pi.json"),
    JSON.stringify({ autoCapture: false, injectBudget: 700 }),
  );
  expect(memoryOptions()).toEqual({ autoCapture: false, injectBudget: 700 });
  expect(memoryOptions({ injectBudget: 900 })).toEqual({
    autoCapture: false,
    injectBudget: 900,
  });
});

test("an explicit configuration path must exist and contain an options object", () => {
  process.env.OMP_MEMORY_CONFIG = join(store.root, "options.json");
  expect(() => memoryOptions()).toThrow("Cannot read");
  writeFileSync(process.env.OMP_MEMORY_CONFIG, "broken");
  expect(() => memoryOptions()).toThrow("Invalid JSON");
  writeFileSync(process.env.OMP_MEMORY_CONFIG, "[]");
  expect(() => memoryOptions()).toThrow("options object");
  writeFileSync(process.env.OMP_MEMORY_CONFIG, '{"autoCapture":"false"}');
  expect(() => memoryOptions()).toThrow("must be boolean");
});
