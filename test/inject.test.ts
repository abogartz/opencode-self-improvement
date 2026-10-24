// Deterministic memory-first: chat.message injection. Hermetic setup mirrors
// scenarios.test.ts (temp OPENCODE_MEMORY_DIR, no repo touch).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/config.ts";
import { formatLine } from "../src/logfmt.ts";
import { contextualPull, relevantKnowledge } from "../src/inject.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-inject-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  mkdirSync(join(root, "repo"), { recursive: true });
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

  test("stopword-only overlap abstains: no block, no noise", async () => {
    // Every memory contains "the"; a query sharing ONLY function words must
    // inject nothing rather than surface a confident wrong memory.
    seed("learning", "ops", "the pager rota rotates weekly and pages route to the alerting channel");
    expect(await relevantKnowledge("what is the thing and how does the it go")).toBe("");
  });

  test("keyword-length query injects on a single shared concept", async () => {
    seed("learning", "ops", "pager rota rotates weekly");
    expect(await relevantKnowledge("pager")).toContain("pager rota");
  });

  test("free-text prompts need two shared concepts: one accidental overlap abstains", async () => {
    // Long queries carry big vocabularies; a single token hit (e.g. an
    // auxiliary colliding with one memory's prose) is coincidence, not topic.
    seed("learning", "ops", "pager rota rotates weekly");
    expect(await relevantKnowledge("who holds the pager tonight")).toBe("");
    expect(await relevantKnowledge("who holds the pager and rotates the rota")).toContain("pager rota");
  });

  test("rare-concept overlap outranks common-word overlap", async () => {
    // ui shares {build, output} with the query, db shares {build, salt}:
    // raw overlap ties at 2, but "salt" is in one memory and "output" in nine.
    for (let i = 0; i < 8; i++) seed("learning", "build", `build output artifact pack step ${i}`);
    seed("learning", "ui", "build output toggle default off");
    seed("learning", "db", "build salt rotation rule");
    const block = await relevantKnowledge("the build output salt");
    const lines = block.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines[0]).toContain("salt");
  });
});

describe("contextualPull budget", () => {
  test("caps the complete appended block at whole-memory boundaries", async () => {
    const budget = 260;
    for (let i = 0; i < 3; i++) {
      seed(
        "learning",
        "search",
        `needle budget result ${i}: ${String.fromCharCode(97 + i).repeat(80)}`,
      );
    }
    const original = "grep: 3 matches";
    const out = { output: original };
    await contextualPull(
      { tool: "grep", args: { pattern: "needle budget" } },
      out,
      budget,
    );

    const appended = String(out.output).slice(original.length);
    expect(appended.length).toBeGreaterThan(0);
    expect(appended.length).toBeLessThanOrEqual(budget);
    expect(appended).toContain("## Related durable memory (pull)");
    for (const line of appended.trimStart().split("\n").slice(1)) {
      expect(line.startsWith("- ")).toBe(true);
    }
  });
});
