// Deterministic memory-first: chat.message injection. Hermetic setup mirrors
// scenarios.test.ts (temp OPENCODE_MEMORY_DIR, no repo touch).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RESTATABLE_TAG } from "../src/core/tags.ts";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { capToBudget, injectedRows } from "../src/inject/budget.ts";
import { formatMemory } from "../src/inject/format.ts";
import { contextualPull } from "../src/inject/pull.ts";
import { relevantKnowledge, selectRelevant } from "../src/recall/relevant.ts";
import type { Memory } from "../src/store/model/memory.ts";

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
  const file = join(
    memoryRoot(),
    `${new Date().toISOString().split("T")[0]}.logfmt`,
  );
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    formatLine({ ts: new Date().toISOString(), type, scope, content }) + "\n",
  );
}

describe("injectedRows (attribution must key off what was actually injected)", () => {
  test("keeps only candidates whose rendered line survived capToBudget", () => {
    const a = {
      ts: "2026-01-01T00:00:00.000Z",
      type: "pattern",
      scope: "s",
      content: "short one",
    } as unknown as Memory;
    const b = {
      ts: "2026-01-02T00:00:00.000Z",
      type: "pattern",
      scope: "s",
      content: "x".repeat(200),
    } as unknown as Memory;
    const raw = [
      "## Relevant durable memory",
      formatMemory(a),
      formatMemory(b),
    ].join("\n");
    const block = capToBudget(raw, formatMemory(a).length + 30); // fits header + a, drops b
    expect(block).toContain(formatMemory(a));
    expect(block).not.toContain(formatMemory(b));
    expect(injectedRows(block, [a, b]).map((m) => m.ts)).toEqual([a.ts]);
  });
  test("empty block keeps nothing", () => {
    expect(injectedRows("", [{ ts: "t" } as unknown as Memory])).toEqual([]);
  });
});

describe("verbatim user quote rendering (mystery 2)", () => {
  test("formatMemory appends the stored original as a quotation", () => {
    const m = {
      ts: "2026-01-01T00:00:00.000Z",
      type: "context",
      scope: "billing",
      content: "Checkout applies a tax rate of 8.25 percent.",
      tags: ["auto-capture", "user-guided"],
      original: "The tax rate is 8.25 percent",
    } as unknown as Memory;
    const line = formatMemory(m);
    expect(line).toContain('(user said: "The tax rate is 8.25 percent")');
    // A row without a stored quote renders exactly as before.
    const { original: _o, ...plain } = m;
    expect(formatMemory(plain as unknown as Memory)).not.toContain("user said");
  });

  test("a guided row's quote reaches the injected block bytes", async () => {
    const m = {
      ts: "2026-01-01T00:00:00.000Z",
      type: "context",
      scope: "billing",
      content: "Checkout applies a tax rate of 8.25 percent.",
      tags: ["auto-capture", "user-guided"],
      original: "the hidden suite charges 8.25 percent on every order total",
    } as unknown as Memory;
    const { block } = await selectRelevant(
      "unrelated prompt words",
      3,
      [m],
      undefined,
      undefined,
      { guidedCap: 3 },
    );
    // The bench needle is a substring of the user's words: rendering the
    // quote makes the exact-text wire check deterministic for guided rows.
    expect(block).toContain("8.25 percent on every order total");
  });
});

describe("relevantKnowledge (memory-first injection)", () => {
  test("selectRelevant returns the matching rows, not just the block (attribution seam)", async () => {
    seed("pattern", "build", "run `bun test` for the suite; see src/gates.ts");
    const { block, selected } = await selectRelevant(
      "how do I run bun test",
      3,
    );
    expect(block).toContain("bun test");
    expect(selected.length).toBe(1);
    expect(selected[0]?.content).toContain("bun test");
  });

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

    expect(
      await relevantKnowledge("run the unit test for multiTexture"),
    ).toContain("npx vitest run multiTexture");
    expect(await relevantKnowledge("how do I run the unit tests")).toContain(
      "npx vitest run",
    );
  });

  test("empty for unrelated or blank messages", async () => {
    seed(
      "pattern",
      "Babylon.js",
      "Run Babylon.js unit tests with npx vitest run.",
    );
    expect(await relevantKnowledge("what is the weather like today")).toBe("");
    expect(await relevantKnowledge("")).toBe("");
    expect(await relevantKnowledge("   ")).toBe("");
  });

  test("caps the injected block at limit", async () => {
    for (let i = 0; i < 5; i++) {
      seed(
        "learning",
        "bench",
        `memory number four-${i} runs the benchmark suite daily`,
      );
    }
    const block = await relevantKnowledge("run the benchmark suite daily");
    expect(block.split("\n").filter((l) => l.startsWith("- [")).length).toBe(3);
  });

  test("stopword-only overlap abstains: no block, no noise", async () => {
    // Every memory contains "the"; a query sharing ONLY function words must
    // inject nothing rather than surface a confident wrong memory.
    seed(
      "learning",
      "ops",
      "the pager rota rotates weekly and pages route to the alerting channel",
    );
    expect(
      await relevantKnowledge("what is the thing and how does the it go"),
    ).toBe("");
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
    expect(
      await relevantKnowledge("who holds the pager and rotates the rota"),
    ).toContain("pager rota");
  });

  test("rare-concept overlap outranks common-word overlap", async () => {
    // ui shares {build, output} with the query, db shares {build, salt}:
    // raw overlap ties at 2, but "salt" is in one memory and "output" in nine.
    for (let i = 0; i < 8; i++)
      seed("learning", "build", `build output artifact pack step ${i}`);
    seed("learning", "ui", "build output toggle default off");
    seed("learning", "db", "build salt rotation rule");
    // The rank is asserted on `selected`, not on the block. #388 renders the
    // block in canonical order, so the bytes never carry score order; this
    // assertion used to pass on the block only because every seeded row landed
    // in the same millisecond and the sort was stable — an accident, not a
    // contract. `selected` is the documented home of the ranking.
    const { block, selected } = await selectRelevant("the build output salt");
    expect(selected[0]?.content).toContain("salt");
    expect(block).toContain("salt");
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

describe("restatable rows give up injection budget first (#402)", () => {
  // Two rows that answer the same prompt. One the working tree already states.
  // The restatable one is the NEWER row, so without the demotion recency alone
  // would put it in the block: the assertion cannot pass by accident of scoring.
  const query = "reorder stock threshold";
  const kept = {
    ts: "2026-01-01T00:00:00.000Z",
    type: "learning",
    scope: "inventory",
    content: "Reorder triggers when stock falls below the threshold.",
    tags: ["auto-capture"],
  } as unknown as Memory;
  const restatable = {
    ts: "2026-02-01T00:00:00.000Z",
    type: "learning",
    scope: "inventory",
    content: "Reorder fires when stock falls below the threshold.",
    tags: ["auto-capture", RESTATABLE_TAG],
  } as unknown as Memory;

  test("a tight budget keeps the fact the tree does not hold", async () => {
    // Budget derived from the rendered block rather than guessed: header plus
    // exactly one line, so the only thing that decides WHO gets the slot is the
    // priority order.
    const full = (await selectRelevant(query, 2, [restatable, kept])).block;
    const oneLine = full.length - formatMemory(restatable).length - 1;
    const { block, selected } = await selectRelevant(
      query,
      2,
      [restatable, kept],
      undefined,
      undefined,
      { budget: oneLine },
    );
    expect(block).toContain(kept.content);
    expect(block).not.toContain(restatable.content);
    // The SELECTION is untouched — only the walk order changed, so the use
    // ledger and attribution still see both rows and a recall miss stays
    // diagnosable against the ranking.
    expect(selected.map((m) => m.ts).sort()).toEqual(
      [kept.ts, restatable.ts].sort(),
    );
  });

  test("a spare budget renders both: a tag is not a delete", async () => {
    const { block } = await selectRelevant(query, 2, [restatable, kept]);
    expect(block).toContain(kept.content);
    expect(block).toContain(restatable.content);
  });
});
