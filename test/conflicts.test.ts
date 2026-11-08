// Contradiction surface (POC): a guided row that declares ref/claim/klass is
// code-checked at render time; a collision renders one CONFLICT line whose
// Action is fixed by the class. #345 measured the alternative: a wrong guided
// row rewrote correct code (raw row) and framing alone stayed a coin flip.
// Hermetic: temp OPENCODE_MEMORY_DIR + temp repo dirs, nothing real touched.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conflictLine,
  findConstant,
  valuesAgree,
} from "../src/recall/conflicts.ts";
import { type Memory } from "../src/store/model/memory.ts";
import { normalizeConflictFields } from "../src/store/model/memory.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { loadAll } from "../src/store/files/load.ts";
import { memoryRoot } from "../src/core/config/paths.ts";
import { loadPlugin } from "./harness.ts";
import { rememberSessionDir } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { appendFileSync } from "node:fs";
import { formatLine } from "../src/core/logfmt/format.ts";
import { selectRelevant } from "../src/recall/relevant.ts";
import { capToBudget, injectedRows } from "../src/inject/budget.ts";
import { formatMemory } from "../src/inject/format.ts";
import { createInjectionEpochs } from "../src/inject/epochs.ts";
import { afterTool } from "../src/capture/triggers.ts";

let root: string;
let repo: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-conflict-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function writeSrc(name: string, text: string): void {
  writeFileSync(join(repo, "src", name), text);
}

function row(over: Partial<Memory>): Memory {
  return {
    ts: "2026-11-07T09:00:00.000Z",
    type: "context",
    scope: "pricing",
    content: "the tax rate",
    file: "x",
    index: 0,
    ...over,
  };
}

describe("findConstant (deterministic code read)", () => {
  test("the default OFF path does not load the source parser", () => {
    writeSrc("pricing.ts", "export const TAX_RATE = 0.08;");
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "helpers", "conflict-parser-load.ts"),
      repo,
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      states: [false, false, true],
      value: "0.08",
    });
  });
  test("reads an exported constant under src/", () => {
    writeSrc("pricing.ts", "export const FREE_SHIPPING_THRESHOLD = 100;\n");
    const fact = findConstant(repo, "FREE_SHIPPING_THRESHOLD");
    expect(fact?.value).toBe("100");
    expect(fact?.file).toBe(join("src", "pricing.ts"));
  });

  test("reads a typed constant and a plain const", () => {
    writeSrc("a.ts", "export const TAX_RATE: number = 0.08;\n");
    writeSrc("b.ts", "const MIN = 3;\n");
    expect(findConstant(repo, "TAX_RATE")?.value).toBe("0.08");
    expect(findConstant(repo, "MIN")?.value).toBe("3");
  });

  test("no declaration yields null; a near-name is not a match", () => {
    writeSrc("a.ts", "export const TAX_CODE = 'A';\n");
    expect(findConstant(repo, "TAX_RATE")).toBeNull();
  });

  test("missing directory yields null, never a throw", () => {
    expect(findConstant(join(root, "nowhere"), "X")).toBeNull();
  });

  test("ignores comments and string/template decoys", () => {
    writeSrc(
      "pricing.ts",
      [
        "// export const TAX_RATE = 0.07;",
        "/* export const TAX_RATE = 0.06; */",
        'const example = "const TAX_RATE = 0.05;";',
        "const template = `example:\nconst TAX_RATE = 0.04;\n`;",
        "export const TAX_RATE = 0.0825;",
      ].join("\n"),
    );
    expect(findConstant(repo, "TAX_RATE")?.value).toBe("0.0825");
  });

  test("computed, local and malformed declarations are undecidable", () => {
    for (const source of [
      "export const TAX_RATE = calculateRate();",
      "export const TAX_RATE = 0.08 + discount;",
      "export const TAX_RATE = 0.08 === discount;",
      "export const TAX_RATE = config.rate;",
      "export const TAX_RATE = `0.08`;",
      "function example() { const TAX_RATE = 0.08; }",
      "if (enabled) { const TAX_RATE = 0.08; }",
      "export const TAX_RATE = 0.08; const broken = ;",
    ]) {
      writeSrc("pricing.ts", source);
      expect(findConstant(repo, "TAX_RATE"), source).toBeNull();
    }
  });

  test("duplicate top-level names across files do not pick an arbitrary authority", () => {
    writeSrc("a.ts", "export const TAX_RATE = 0.08;");
    writeSrc("b.ts", "export const TAX_RATE = 0.09;");
    expect(findConstant(repo, "TAX_RATE")).toBeNull();
  });

  test("supports multiline typed literals, signed numbers and trailing comments", () => {
    writeSrc(
      "pricing.ts",
      "export const TAX_RATE: number =\n -0.08; // current value\n",
    );
    expect(findConstant(repo, "TAX_RATE")?.value).toBe("-0.08");
  });

  test("does not read linked source directories outside the repo", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "pricing.ts"), "export const TAX_RATE = 0.08;");
    symlinkSync(outside, join(repo, "src", "linked"), "junction");
    expect(findConstant(repo, "TAX_RATE")).toBeNull();
    const linkedRepo = join(root, "linked-repo");
    mkdirSync(linkedRepo);
    symlinkSync(outside, join(linkedRepo, "src"), "junction");
    expect(findConstant(linkedRepo, "TAX_RATE")).toBeNull();
  });

  test("exhausted file/byte budgets abstain instead of choosing a partial authority", () => {
    writeSrc("pricing.ts", "export const TAX_RATE = 0.08;");
    writeSrc("large.ts", " ".repeat(256 * 1024 + 1));
    expect(findConstant(repo, "TAX_RATE")).toBeNull();
    writeSrc("large.ts", "");
    for (let n = 0; n < 300; n++) writeSrc(`f${n}.ts`, "// ordinary file");
    expect(findConstant(repo, "TAX_RATE")).toBeNull();
  });
});

describe("valuesAgree", () => {
  test("exact, currency and percent forms agree", () => {
    expect(valuesAgree("0.0825", "0.0825")).toBe(true);
    expect(valuesAgree("$50.00", "50")).toBe(true);
    expect(valuesAgree("8.25%", "0.0825")).toBe(true);
    expect(valuesAgree("A", "'A'")).toBe(true);
  });
  test("different values disagree", () => {
    expect(valuesAgree("0.0825", "0.08")).toBe(false);
    expect(valuesAgree("50", "100")).toBe(false);
    expect(valuesAgree("8.25", "0.0825")).toBe(false);
  });
  test("percent is always a fraction; string whitespace remains significant", () => {
    expect(valuesAgree("10%", "10")).toBe(false);
    expect(valuesAgree("10%", "0.1")).toBe(true);
    expect(valuesAgree("8.2%", "0.082")).toBe(true);
    expect(valuesAgree("8.2e1%", "0.82")).toBe(true);
    expect(valuesAgree("hello world", "'helloworld'")).toBe(false);
  });
  test("a nonnumeric claim cannot decide a numeric code value", () => {
    expect(valuesAgree("about eight percent", "0.08")).toBeUndefined();
  });
});

describe("conflictLine", () => {
  test("behavior class: trust the code, do not edit", () => {
    const line = conflictLine(
      row({
        ref: "FREE_SHIPPING_THRESHOLD",
        claim: "$50.00",
        klass: "behavior",
      }),
      { file: "src/pricing.ts", value: "100" },
    );
    expect(line).toContain("CONFLICT (FREE_SHIPPING_THRESHOLD)");
    expect(line).toContain("user-stated, never verified");
    expect(line).toContain(
      "FREE_SHIPPING_THRESHOLD = 100 (observed in src/pricing.ts)",
    );
    expect(line).toContain("Class: behavior");
    expect(line).toContain("do not edit FREE_SHIPPING_THRESHOLD");
  });
  test("spec class: the code is the bug, fix it", () => {
    const line = conflictLine(
      row({ ref: "TAX_RATE", claim: "0.0825", klass: "spec" }),
      { file: "src/pricing.ts", value: "0.08" },
    );
    expect(line).toContain("Class: spec");
    expect(line).toContain("fix TAX_RATE to 0.0825");
  });
});

describe("normalizeConflictFields", () => {
  test("keeps a well-formed triple; drops junk fields only, never the row", () => {
    expect(
      normalizeConflictFields({
        ref: "TAX_RATE",
        claim: "0.0825",
        klass: "spec",
      }),
    ).toEqual({ ref: "TAX_RATE", claim: "0.0825", klass: "spec" });
    expect(
      normalizeConflictFields({
        ref: "not an identifier!",
        claim: "x".repeat(33),
        klass: "maybe",
      }),
    ).toEqual({});
  });
});

describe("store round-trip", () => {
  test("appendMemory persists ref/claim/klass and loadAll reads them back", async () => {
    const ts = await appendMemory({
      type: "context",
      scope: "pricing",
      content: "The sales tax rate is 8.25% (0.0825), applied after discounts.",
      tags: ["auto-capture", "user-guided"],
      ref: "TAX_RATE",
      claim: "0.0825",
      klass: "spec",
    });
    const loaded = await loadAll();
    const m = loaded.find((x) => x.ts === ts);
    expect(m?.ref).toBe("TAX_RATE");
    expect(m?.claim).toBe("0.0825");
    expect(m?.klass).toBe("spec");
  });
});

// --- injection integration through the real plugin hooks ---------------------

type Loaded = Awaited<ReturnType<typeof loadPlugin>>;

function seedGuided(extra: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(memoryRoot(), { recursive: true });
  appendFileSync(
    file,
    formatLine({
      ts,
      type: "context",
      scope: "pricing",
      content:
        "The sales tax rate is 8.25% (0.0825), applied after discounts and rounded to cents at the end.",
      tags: "auto-capture,user-guided",
      status: "settled",
      ...extra,
    }) + "\n",
  );
}

async function deliveredBlock(
  loaded: Loaded,
  sid: string,
  text: string,
): Promise<string> {
  await loaded.sessionHooks["prompt"]!({ sessionID: sid, prompt: { text } });
  const delivered: {
    sessionID: string;
    system: Array<{ type: string; text: string }>;
  } = { sessionID: sid, system: [] };
  await loaded.sessionHooks["context"]!(delivered);
  return delivered.system
    .map((p) => p.text)
    .filter((t) => t.includes("## Relevant durable memory"))
    .join("\n");
}

describe("injection renders the CONFLICT line (opt-in)", () => {
  test("epochs credit stored prose but attribute only refs actually rendered", async () => {
    writeSrc("pricing.ts", "export const TAX_RATE = 0.08;");
    const prose =
      "The sales tax rate is 8.25%; see legacy/rules.ts for the old guidance.";
    seedGuided({
      ref: "TAX_RATE",
      claim: "0.0825",
      klass: "spec",
      content: prose,
    });
    const sid = "conflict-ledger-identity";
    rememberSessionDir(sid, repo);
    let credited: Memory[] = [];
    const epochs = createInjectionEpochs({
      budget: 4000,
      frontierBudget: 1000,
      contradictionSurface: true,
      measuredTurns: new Map(),
      noteHits: async (_sid, rows) => {
        credited = rows;
      },
    });
    await epochs.prompt(sid, "Repair deployment");
    const delivered: string[] = [];
    await epochs.deliver(sid, (text) => delivered.push(text));
    expect(delivered.join("\n")).toContain("CONFLICT (TAX_RATE)");
    expect(credited).toHaveLength(1);
    expect(credited[0]?.content).toBe(prose);
    await afterTool(
      {
        tool: "read",
        sessionID: sid,
        callID: "read",
        args: { filePath: "legacy/rules.ts" },
      },
      { output: "old guidance" },
    );
    const payload = await epochs.buildPayload(sid);
    expect(payload?.attribution?.pathsCited).toBe(1);
    expect(payload?.attribution?.pathsReRead).toBe(0);
    expect(payload?.attribution?.readsNotCovered).toBe(1);
  });

  test("selection retains stored identity while budgeting uses the rendered conflict", async () => {
    writeSrc("pricing.ts", "export const TAX_RATE = 0.08;");
    const original = row({
      tags: ["user-guided"],
      ref: "TAX_RATE",
      claim: "0.0825",
      klass: "spec",
    });
    const selection = await selectRelevant(
      "Repair deployment",
      3,
      [original],
      undefined,
      undefined,
      {
        guidedCap: 3,
        conflictCheck: true,
        repoDir: repo,
      },
    );
    expect(selection.block).toContain("CONFLICT (TAX_RATE)");
    expect(selection.selected[0]).toBe(original);
    expect(original.content).toBe("the tax rate");
    expect(
      injectedRows(selection.block, selection.selected, selection.rendered),
    ).toEqual([original]);
    const tiny = capToBudget(
      selection.block,
      selection.block.split("\n")[0].length + formatMemory(original).length + 1,
    );
    expect(tiny).toBe("");
    expect(injectedRows(tiny, selection.selected, selection.rendered)).toEqual(
      [],
    );
  });

  test("computed code or an undecidable claim keeps the plain caveat", async () => {
    for (const [code, claim] of [
      ["calculateRate()", "0.0825"],
      ["0.08", "about eight percent"],
    ]) {
      writeSrc("pricing.ts", `export const TAX_RATE = ${code};`);
      const selection = await selectRelevant(
        "Repair deployment",
        3,
        [
          row({
            tags: ["user-guided"],
            ref: "TAX_RATE",
            claim,
            klass: "spec",
          }),
        ],
        undefined,
        undefined,
        { guidedCap: 3, conflictCheck: true, repoDir: repo },
      );
      expect(selection.block).not.toContain("CONFLICT");
      expect(selection.block).toContain("verify against the current code");
    }
  });
  test("collision + spec class: the row renders as a spec CONFLICT", async () => {
    writeSrc("pricing.ts", "export const TAX_RATE = 0.08;\n");
    seedGuided({ ref: "TAX_RATE", claim: "0.0825", klass: "spec" });
    const loaded = await loadPlugin(repo, { contradictionSurface: true });
    rememberSessionDir("ses-conf-spec", repo);
    const block = await deliveredBlock(
      loaded,
      "ses-conf-spec",
      "identify the injected bug so the hidden suite passes",
    );
    expect(block).toContain("CONFLICT (TAX_RATE)");
    expect(block).toContain("TAX_RATE = 0.08 (observed in");
    expect(block).toContain("Class: spec");
    expect(block).toContain("fix TAX_RATE to 0.0825");
    // Arm F run 2.1: the plain caveat let a neighboring "trust the code" row
    // swallow the verdict. With a code-checked CONFLICT riding, the HEADER
    // states the check is done and the Action governs.
    const header = block.split("\n")[0] ?? "";
    expect(header).toContain("code-checked");
    expect(header).toContain("follow their Action");
  });

  test("plain guided rows keep the staleness caveat, not the CONFLICT one", async () => {
    seedGuided({});
    const loaded = await loadPlugin(repo, { contradictionSurface: true });
    rememberSessionDir("ses-conf-plain-head", repo);
    const block = await deliveredBlock(
      loaded,
      "ses-conf-plain-head",
      "identify the injected bug so the hidden suite passes",
    );
    const header = block.split("\n")[0] ?? "";
    expect(header).toContain("verify against the current code");
    expect(header).not.toContain("code-checked");
  });

  test("collision + behavior class: the row renders as a do-not-edit CONFLICT", async () => {
    writeSrc("pricing.ts", "export const FREE_SHIPPING_THRESHOLD = 100;\n");
    seedGuided({
      ref: "FREE_SHIPPING_THRESHOLD",
      claim: "$50.00",
      klass: "behavior",
    });
    const loaded = await loadPlugin(repo, { contradictionSurface: true });
    rememberSessionDir("ses-conf-beh", repo);
    const block = await deliveredBlock(
      loaded,
      "ses-conf-beh",
      "identify the injected bug so the hidden suite passes",
    );
    expect(block).toContain("CONFLICT (FREE_SHIPPING_THRESHOLD)");
    expect(block).toContain("Class: behavior");
    expect(block).toContain("do not edit FREE_SHIPPING_THRESHOLD");
  });

  test("code agrees with the claim: the row rides plain, no CONFLICT", async () => {
    writeSrc("pricing.ts", "export const TAX_RATE = 0.0825;\n");
    seedGuided({ ref: "TAX_RATE", claim: "0.0825", klass: "spec" });
    const loaded = await loadPlugin(repo, { contradictionSurface: true });
    rememberSessionDir("ses-conf-agree", repo);
    const block = await deliveredBlock(
      loaded,
      "ses-conf-agree",
      "what sales tax rule applies to pricing",
    );
    expect(block).toContain("8.25");
    expect(block).not.toContain("CONFLICT");
  });

  test("no ref on the row: plain guided injection, unchanged", async () => {
    seedGuided({});
    const loaded = await loadPlugin(repo, { contradictionSurface: true });
    rememberSessionDir("ses-conf-noref", repo);
    const block = await deliveredBlock(
      loaded,
      "ses-conf-noref",
      "identify the injected bug so the hidden suite passes",
    );
    expect(block).toContain("8.25");
    expect(block).not.toContain("CONFLICT");
  });

  test("a colliding guided row without klass stays plain; authority is never guessed", async () => {
    writeSrc("pricing.ts", "export const TAX_RATE = 0.08;\n");
    seedGuided({ ref: "TAX_RATE", claim: "0.0825" });
    const loaded = await loadPlugin(repo, { contradictionSurface: true });
    rememberSessionDir("ses-conf-unclassified", repo);
    const block = await deliveredBlock(
      loaded,
      "ses-conf-unclassified",
      "Repair the deployment manifest",
    );
    expect(block).toContain("8.25");
    expect(block).not.toContain("CONFLICT");
    expect(block).toContain("verify against the current code");
    expect(block).not.toContain("code-checked");
    await loaded.cleanup();
  });

  test("feature OFF (default): a colliding guided row renders plain", async () => {
    writeSrc("pricing.ts", "export const TAX_RATE = 0.08;\n");
    seedGuided({ ref: "TAX_RATE", claim: "0.0825", klass: "spec" });
    const loaded = await loadPlugin(repo);
    rememberSessionDir("ses-conf-off", repo);
    const block = await deliveredBlock(
      loaded,
      "ses-conf-off",
      "identify the injected bug so the hidden suite passes",
    );
    expect(block).toContain("8.25");
    expect(block).not.toContain("CONFLICT");
  });
});
