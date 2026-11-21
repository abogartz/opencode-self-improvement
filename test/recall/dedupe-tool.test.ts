// Dedup default ON through the real memory_recall handler. The unit
// suite pins dedupeWindow directly; without this file, hardcoding `0` at
// src/tools/recall.ts could pass CI while the shipped default silently
// stayed off — the exact failure mode the flag flip is meant to end.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../../src/core/config/paths.ts";
import { formatLine } from "../../src/core/logfmt/format.ts";
import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { loadPlugin } from "../harness.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-dedup-tool-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  // Isolate dedup: the query gate is a separate default-ON path with its own
  // suite (recall-gate.test.ts).
  process.env.OPENCODE_MEMORY_QUERY_GATE = "off";
  delete process.env.OPENCODE_MEMORY_DEDUP;
  delete process.env.OPENCODE_MEMORY_AMBIGUOUS;
  resetState();
  setRepoScope(null);
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_QUERY_GATE;
  delete process.env.OPENCODE_MEMORY_DEDUP;
  delete process.env.OPENCODE_MEMORY_AMBIGUOUS;
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

function seed(content: string, ts: string, scope = "release") {
  const day = "2026-01-01";
  const file = join(memoryRoot(), `${day}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${formatLine({
      ts,
      type: "learning",
      scope,
      content,
      status: "settled",
    })}\n`,
  );
}

// Same scope, Jaccard 6/7 ≈ 0.86 >= 0.8 on content tokens; the weekday is
// the only difference, so the newer row must take the slot (§17).
const FRIDAY =
  "the deploy runbook rotates the signing key every friday after the backup window";
const MONDAY =
  "the deploy runbook rotates the signing key every monday after the backup window";

describe("memory_recall dedup default", () => {
  test("by default, the near-copy is suppressed and the newer copy survives", async () => {
    seed(FRIDAY, "2026-01-01T00:00:00.000Z");
    seed(MONDAY, "2026-01-01T00:00:01.000Z");
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "deploy runbook signing key",
      limit: 5,
    });
    expect(out).toContain("every monday");
    expect(out).not.toContain("every friday");
    await loaded.cleanup();
  });

  test("OPENCODE_MEMORY_DEDUP=0 returns both copies", async () => {
    seed(FRIDAY, "2026-01-01T00:00:00.000Z");
    seed(MONDAY, "2026-01-01T00:00:01.000Z");
    process.env.OPENCODE_MEMORY_DEDUP = "0";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "deploy runbook signing key",
      limit: 5,
    });
    expect(out).toContain("every monday");
    expect(out).toContain("every friday");
    await loaded.cleanup();
  });
});

// The pair that motivated the grouping rule, end to end: without this file the
// rule could pass its unit suite while the shipped tool still returned one
// command, or return both without ever saying why.
const BUILD =
  'BabylonDocs build command: run "npm run build" from the repo root (package.json).';
const BUILD_EXAMPLES =
  'BabylonDocs build:example-images command: run "npm run build:example-images" from the repo root (package.json).';

describe("memory_recall additive clash", () => {
  test("both commands return, with a line naming why", async () => {
    seed(BUILD, "2026-01-01T00:00:00.000Z", "BabylonDocs");
    seed(BUILD_EXAMPLES, "2026-01-01T00:00:01.000Z", "BabylonDocs");
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "BabylonDocs build command",
      limit: 5,
    });
    expect(out).toContain("npm run build");
    expect(out).toContain("npm run build:example-images");
    expect(out).toContain("AMBIGUOUS (BabylonDocs)");
    expect(out).toContain("neither supersedes the other");
    await loaded.cleanup();
  });

  test("OPENCODE_MEMORY_AMBIGUOUS=0 collapses the pair again", async () => {
    seed(BUILD, "2026-01-01T00:00:00.000Z", "BabylonDocs");
    seed(BUILD_EXAMPLES, "2026-01-01T00:00:01.000Z", "BabylonDocs");
    process.env.OPENCODE_MEMORY_AMBIGUOUS = "0";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "BabylonDocs build command",
      limit: 5,
    });
    expect(out).toContain("npm run build:example-images");
    expect(out).not.toContain("AMBIGUOUS");
    await loaded.cleanup();
  });

  test("a duplicate of a grouped row does not evict a distinct row", async () => {
    // Through the handler, where the slot is the thing that matters: the third
    // row is byte-identical to the second, so it must take the second's slot
    // rather than the third one.
    seed(BUILD, "2026-01-01T00:00:01.000Z", "BabylonDocs");
    seed(BUILD_EXAMPLES, "2026-01-01T00:00:02.000Z", "BabylonDocs");
    seed(BUILD_EXAMPLES, "2026-01-01T00:00:03.000Z", "BabylonDocs");
    seed(
      "BabylonDocs requires npm >= 11.10.0 per the engines field, the default node fails npm ci, use homebrew node",
      "2026-01-01T00:00:04.000Z",
      "BabylonDocs",
    );
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "BabylonDocs build command",
      limit: 3,
    });
    expect(out.match(/npm run build:example-images/g)?.length).toBe(1);
    expect(out).toContain("npm >= 11.10.0");
    expect(out.match(/AMBIGUOUS/g)?.length).toBe(1);
    await loaded.cleanup();
  });

  test("a chain of nested rows produces one marker, not one per pair", async () => {
    // Eight rows, each a superset of the last, so every pair inside the window
    // is additive. A pair-per-marker renderer emitted C(5,2) = 10 lines for
    // five facts; a family is one line.
    const common = "deploy runbook for the ingest worker restarts the pod";
    for (let i = 0; i < 8; i++)
      seed(
        `${common} ${Array.from({ length: i + 1 }, (_, j) => `step${j}`).join(" ")}`,
        `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        "runbook",
      );
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "deploy runbook ingest worker",
      limit: 5,
    });
    expect(out.match(/AMBIGUOUS/g)?.length).toBe(1);
    expect(out.match(/Action:/g)?.length).toBe(1);
    expect(out.match(/^- \[2026-01-01\]/gm)?.length).toBe(5);
    await loaded.cleanup();
  });

  test("a corrected fact returns one row and no marker", async () => {
    // The marker is only for pairs that both hold. A stale row must not come
    // back wearing one.
    seed(FRIDAY, "2026-01-01T00:00:00.000Z");
    seed(MONDAY, "2026-01-01T00:00:01.000Z");
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "deploy runbook signing key",
      limit: 5,
    });
    expect(out).toContain("every monday");
    expect(out).not.toContain("every friday");
    expect(out).not.toContain("AMBIGUOUS");
    await loaded.cleanup();
  });

  // The checklist stated three ways, then the longer one typed twice, then two
  // unrelated release rows. The duplicate wins a substitution clash on its way
  // past a row it is an exact copy of, so it lands in a slot while its own copy
  // holds another — and `printer`, a distinct match, is the row that pays.
  const CHECKLIST =
    "release checklist covers packaging signing testing auditing deployment monitoring alerts backups metrics tracing documentation";
  const WITH_STAGING = `${CHECKLIST} staging`;
  function seedChecklistClash(): void {
    seed(CHECKLIST, "2026-01-01T00:00:00.000Z", "release");
    seed(WITH_STAGING, "2026-01-01T00:00:01.000Z", "release");
    seed(
      CHECKLIST.replace("documentation", "rollbacks"),
      "2026-01-01T00:00:02.000Z",
      "release",
    );
    seed(WITH_STAGING, "2026-01-01T00:00:03.000Z", "release");
    seed(
      "release printer driver requires manual installation",
      "2026-01-01T00:00:04.000Z",
      "release",
    );
    seed(
      "release calendar meeting uses the shared agenda",
      "2026-01-01T00:00:05.000Z",
      "release",
    );
  }

  test("a copy that wins a clash returns once and costs no distinct row its slot", async () => {
    seedChecklistClash();
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "release",
      limit: 3,
    });
    expect(out.match(/documentation staging/g)?.length).toBe(1);
    expect(out).toContain("printer driver");
    expect(out).toContain("calendar meeting");
    expect(out.match(/^- \[2026-01-01\]/gm)?.length).toBe(3);
    await loaded.cleanup();
  });

  test("OPENCODE_MEMORY_AMBIGUOUS=0 returns the same three rows for that fixture", async () => {
    seedChecklistClash();
    process.env.OPENCODE_MEMORY_AMBIGUOUS = "0";
    const loaded = await loadPlugin(root);
    const out = await loaded.tool.memory_recall!.execute({
      query: "release",
      limit: 3,
    });
    expect(out.match(/documentation staging/g)?.length).toBe(1);
    expect(out).toContain("printer driver");
    expect(out).toContain("calendar meeting");
    expect(out).not.toContain("AMBIGUOUS");
    await loaded.cleanup();
  });
});
