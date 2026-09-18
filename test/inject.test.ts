// Deterministic memory-first: chat.message injection. Hermetic setup mirrors
// scenarios.test.ts (temp OPENCODE_MEMORY_DIR, no repo touch).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/config.ts";
import { formatLine } from "../src/logfmt.ts";
import { relevantKnowledge } from "../src/inject.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-inject-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  mkdirSync(join(root, "repo"), { recursive: true });
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
});

function seed(type: string, scope: string, content: string): void {
  const file = join(memoryRoot(), `${new Date().toISOString().split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    formatLine({ ts: new Date().toISOString(), type, scope, content }) + "\n",
  );
}

describe("relevantKnowledge (memory-first injection)", () => {
  test("injects the matching command memory for a lookup-style message", async () => {
    seed(
      "pattern",
      "Babylon.js",
      "Run Babylon.js unit tests with npx vitest run from the repo root; pass a class name to target a suite, e.g. npx vitest run multiTexture.",
    );
    seed(
      "pattern",
      "Babylon.js",
      'Babylon.js build:dev command: run "npm run build:dev" from the repo root.',
    );

    expect(await relevantKnowledge("run the unit test for multiTexture")).toContain(
      "npx vitest run multiTexture",
    );
    expect(await relevantKnowledge("how do I run the unit tests")).toContain("npx vitest run");
  });

  test("empty for unrelated or blank messages", async () => {
    seed("pattern", "Babylon.js", "Run Babylon.js unit tests with npx vitest run.");
    expect(await relevantKnowledge("what is the weather like today")).toBe("");
    expect(await relevantKnowledge("")).toBe("");
    expect(await relevantKnowledge("   ")).toBe("");
  });

  test("caps the injected block at limit", async () => {
    for (let i = 0; i < 5; i++) {
      seed("learning", "bench", `memory number four-${i} runs the benchmark suite daily`);
    }
    const block = await relevantKnowledge("run the benchmark suite daily");
    expect(block.split("\n").filter((l) => l.startsWith("- [")).length).toBe(3);
  });
});