// Learning from failure (S1, PLAN-learn-from-failure-2026-11-10.md).
//
// Measured on 2026-11-10 (bench results-learn-t3-diag): a session that failed
// after 574 s and 33,287 tokens produced ONE captured row, and it was a
// paraphrase of a sentence in the task brief. Zero lesson-shaped rows. The
// capture prompt never asks for failure knowledge — prompt.ts listed "blockers
// hit" once, in passing, and the file greps empty for fail / dead end /
// ruled out. The model was not declining to store lessons; it was never asked.
//
// The literature says the way this fails is by storing WRONG lessons, not by
// missing right ones: ReMe (Findings ACL 2026) found selective addition beats
// full addition, because one failed trajectory rarely carries enough context
// for a correct analysis and yields misguided experiences. So the load-bearing
// part of this change is not the prompt, it is the attestation: a lesson may
// only be written about a command that actually ran and actually failed, read
// from the deterministic tool ledger rather than from the model's impression.
// An unattested lesson is a rumour, and the runtime drops the ROW.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseCandidates } from "../src/capture/candidates.ts";
import { buildCapturePrompt } from "../src/capture/prompt.ts";
import { attestedGateFailures } from "../src/capture/policy.ts";
import { gateCmd } from "../src/capture/triggers.ts";
import { resetCaptureCooldowns, resetSessionModels } from "../src/index.ts";
import type { SessionState, ToolResult } from "../src/core/state.ts";
import { loadAll } from "../src/store/files/load.ts";
import { loadPlugin, withTempStore } from "./harness.ts";
import { readEvidenceLog } from "./helpers/logfmt.ts";

const call = (over: Partial<ToolResult>): ToolResult => ({
  call: `c-${Math.random().toString(36).slice(2, 8)}`,
  tool: "read",
  summary: "",
  ts: "2026-01-01T00:00:00.000Z",
  status: null,
  ...over,
});

const state = (calls: ToolResult[], turns = 5): SessionState =>
  ({
    sid: "ses-lesson",
    calls,
    callsTotal: calls.length,
    reDerives: 0,
    sawEngagement: true,
    sawGateCheck: false,
    lastByTool: new Map(),
    pendingGate: null,
    turns,
    finalized: false,
  }) as SessionState;

const gate = (
  cmd: string,
  status: "FAIL" | "PASS",
  turn: number,
  arg?: string,
): ToolResult =>
  call({
    tool: "bash",
    gateCheck: true,
    cmd,
    arg,
    status,
    turn,
  });

describe("attestedGateFailures — what may a lesson be about", () => {
  test("a gate that failed and never passed is attested", () => {
    const s = state([gate("test", "FAIL", 3, "bun test ./src/cart.test.ts")]);
    const list = attestedGateFailures(s, 0);
    expect(list.length).toBe(1);
    expect(list[0].cmd).toBe("test");
    expect(list[0].arg).toBe("bun test ./src/cart.test.ts");
  });

  test("a gate that later passed is NOT attested — it was fixed, not learned", () => {
    const s = state([
      gate("test", "FAIL", 2, "bun test"),
      gate("test", "PASS", 4, "bun test"),
    ]);
    expect(attestedGateFailures(s, 0)).toEqual([]);
  });

  test("one family's recovery does not attest away another family's failure", () => {
    const s = state([
      gate("test", "FAIL", 2, "bun test"),
      gate("lint", "FAIL", 3, "bun run lint"),
      gate("test", "PASS", 4, "bun test"),
    ]);
    const list = attestedGateFailures(s, 0);
    expect(list.map((f) => f.cmd)).toEqual(["lint"]);
  });

  test("only the window counts, so the same failure is not re-mined each pass", () => {
    const s = state([gate("test", "FAIL", 2, "bun test")]);
    expect(attestedGateFailures(s, 3)).toEqual([]);
  });

  test("the list is bounded and in first-failure order", () => {
    const s = state(
      Array.from({ length: 12 }, (_, i) =>
        gate(`fam${i}`, "FAIL", 1, `cmd ${i}`),
      ),
    );
    const list = attestedGateFailures(s, 0);
    expect(list.length).toBeLessThanOrEqual(8);
    expect(list[0].cmd).toBe("fam0");
  });

  test("a non-gate command is not a gate failure", () => {
    const s = state([
      call({ tool: "bash", status: "FAIL", turn: 3, arg: "grep -r x ." }),
    ]);
    expect(attestedGateFailures(s, 0)).toEqual([]);
  });
});

describe("the test command is a gate", () => {
  // gateCmd matched vitest, playwright, lint and tsc, but not `bun test`,
  // `npm test` or `pytest`. A failing test run is the single most
  // lesson-shaped event available, and it was invisible to the ledger, so
  // `gateRecovered` could not fire for the commonest case either.
  test("the common test runners are gate families", () => {
    for (const cmd of [
      "bun test",
      "bun test ./src/cart.test.ts",
      "npm test",
      "pnpm run test --watch=false",
      "deno test",
      "pytest -q",
      "go test ./...",
      "make test",
    ])
      expect(gateCmd(cmd)).toBe("test");
  });

  test("an existing family still wins where both could match", () => {
    expect(gateCmd("pnpm vitest run")).toBe("vitest");
    expect(gateCmd("bun run lint")).toBe("lint");
  });

  test("a path that merely contains 'test' is not a test run", () => {
    // `ls src/test` and `cat test/fixtures/a.json` must not become gates.
    for (const cmd of [
      "ls src/test",
      "cat test/fixtures/a.json",
      "git add src/testing/helpers.ts",
      "echo retesting",
      "sed -i '' 's/a/b/' latest.ts",
    ])
      expect(gateCmd(cmd)).toBeNull();
  });
});

describe("capture prompt asks for a lesson, in rule form, attested", () => {
  const ATTESTED = ["test — bun test ./src/cart.test.ts"];

  test("an attested failure is shown to the model as such", () => {
    const p = buildCapturePrompt("agent: tried the fix", 3, "", "", ATTESTED);
    expect(p).toContain("ATTESTED FAILURES");
    expect(p).toContain("bun test ./src/cart.test.ts");
  });

  test("the rule form is when/avoid and it must name a file or symbol", () => {
    const p = buildCapturePrompt("agent: tried the fix", 3, "", "", ATTESTED);
    expect(p).toContain("when <condition>, avoid <action>");
    expect(p).toMatch(/[Nn]ame[s]? a (file|symbol)/);
  });

  test("a lesson must cite one of the listed failures, and nothing else may", () => {
    const p = buildCapturePrompt("agent: tried the fix", 3, "", "", ATTESTED);
    expect(p).toContain('"failure"');
    expect(p).toMatch(/ONLY from/);
    expect(p).toMatch(/no `?blocker`?/i);
  });

  test("with nothing attested the prompt says so and forbids a lesson", () => {
    const p = buildCapturePrompt("agent: tried the fix", 3, "", "", []);
    expect(p).not.toContain("ATTESTED FAILURES");
    expect(p).toMatch(/No command failed/);
  });

  test("the prompt is unchanged when the argument is omitted", () => {
    // Callers that do not know about this must keep today's bytes exactly.
    expect(buildCapturePrompt("transcript body here", 3)).toBe(
      buildCapturePrompt("transcript body here", 3, "", "", undefined),
    );
  });
});

describe("parseCandidates carries a lesson's citation", () => {
  const LESSON = {
    type: "blocker",
    scope: "cart",
    content:
      "when a cart spans two warehouses, avoid summing in report.ts — the merge in warehouse.ts drops the backorder flag",
  };

  test("a blocker with a string failure keeps it", () => {
    const full = { ...LESSON, failure: "bun test ./src/cart.test.ts" };
    expect(parseCandidates(JSON.stringify([full]), 3)).toEqual([full]);
  });

  test("junk, over-long and non-blocker rows lose the field, never the row", () => {
    for (const failure of [42, true, null, {}, [], "", "   "]) {
      expect(
        parseCandidates(JSON.stringify([{ ...LESSON, failure }]), 3),
      ).toEqual([LESSON]);
    }
    expect(
      parseCandidates(
        JSON.stringify([{ ...LESSON, failure: "x".repeat(201) }]),
        3,
      ),
    ).toEqual([LESSON]);
    // A non-blocker type cannot cite a failure.
    expect(
      parseCandidates(
        JSON.stringify([{ ...LESSON, type: "context", failure: "bun test" }]),
        3,
      ),
    ).toEqual([{ ...LESSON, type: "context" }]);
  });

  test("a newline in the citation would break the logfmt row, so it is dropped", () => {
    expect(
      parseCandidates(
        JSON.stringify([{ ...LESSON, failure: "bun test\nrm -rf /" }]),
        3,
      ),
    ).toEqual([LESSON]);
  });
});

describe("an unattested lesson is refused, not stored", () => {
  const fixture = withTempStore({ prefix: "osi-capture-lesson-" });
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | undefined;

  beforeEach(() => {
    resetCaptureCooldowns();
    resetSessionModels();
  });
  afterEach(async () => {
    await plugin?.cleanup();
    plugin = undefined;
  });

  const LESSON = {
    type: "blocker",
    scope: "cart",
    content:
      "when the cart spans two warehouses, avoid summing in report.ts — mergeStock in warehouse.ts drops the backorder flag",
    failure: "bun test ./src/cart.test.ts",
  };

  /** One session: an edit (so capture is worth paying for), a failing test run
   *  when `failing`, then the scripted capture reply. */
  async function capture(
    sid: string,
    failing: boolean,
    opts: { failingCmd?: string; lesson?: unknown } = {},
  ) {
    const repo = join(fixture.root, `repo-${sid}`);
    mkdirSync(repo, { recursive: true });
    plugin = await loadPlugin(repo, {
      autoCapture: true,
      captureModel: "fake/model",
    });
    await plugin["tool.execute.after"](
      {
        tool: "edit",
        sessionID: sid,
        callID: `${sid}-edit`,
        args: { filePath: "src/cart.ts" },
      },
      { output: "edited", metadata: {} },
    );
    if (failing)
      await plugin["tool.execute.after"](
        {
          tool: "bash",
          sessionID: sid,
          callID: `${sid}-test`,
          args: { command: opts.failingCmd ?? "bun test ./src/cart.test.ts" },
        },
        {
          output: "(fail) cart > total [2ms]\n1 fail\n0 pass",
          metadata: { exit: 1 },
        },
      );
    plugin.capture.context.messages = [
      {
        role: "user",
        content:
          "Fix the cart totals. The hidden suite is red and I cannot see the tests, so read the source and work it out.".repeat(
            3,
          ),
      },
    ];
    plugin.capture.generate.response = JSON.stringify([opts.lesson ?? LESSON]);
    plugin.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: sid },
    });
    const deadline = Date.now() + 6000;
    while (
      !readEvidenceLog().some(
        (event) => event.ev === "capture_lag" && event.session === sid,
      )
    ) {
      if (Date.now() >= deadline) throw new Error("capture did not complete");
      await Bun.sleep(5);
    }
  }

  test("a lesson citing a command that really failed is stored", async () => {
    await capture("lesson-attested", true);
    const rows = await loadAll();
    const row = rows.find((r) => r.scope === "cart");
    expect(row?.type).toBe("blocker");
    expect(row?.content).toInclude("avoid summing in report.ts");
    expect(row?.tags).toContain("auto-capture");
  });

  test("the same lesson with no failing command in the ledger is refused", async () => {
    await capture("lesson-unattested", false);
    const rows = await loadAll();
    expect(rows.find((r) => r.scope === "cart")).toBeUndefined();
    // And it must not vanish silently: the refusal is a receipt.
    const receipt = readEvidenceLog().find(
      (e) =>
        e.ev === "auto_capture_lessons" && e.session === "lesson-unattested",
    );
    expect(receipt).toBeDefined();
    expect(String(receipt?.refused)).toBe("1");
  });

  test("a substring of a failing command is not the failing command", async () => {
    // Review #384 finding 2: the only failure was
    // `bun test --test-name-pattern tsc`; a lesson citing bare `tsc` was
    // accepted by the joined-haystack includes() although no typecheck ran.
    // The prompt demands the citation copied EXACTLY; set membership is that
    // rule.
    await capture("lesson-substring", true, {
      failingCmd: "bun test --test-name-pattern tsc",
      lesson: { ...LESSON, failure: "tsc" },
    });
    expect((await loadAll()).find((r) => r.scope === "cart")).toBeUndefined();
    const receipt = readEvidenceLog().find(
      (e) =>
        e.ev === "auto_capture_lessons" && e.session === "lesson-substring",
    );
    expect(String(receipt?.refused)).toBe("1");
    expect(String(receipt?.kept)).toBe("0");
  });

  test("the exact citation still passes under set membership — no recall loss", async () => {
    await capture("lesson-exact", true, {
      failingCmd: "bun test --test-name-pattern tsc",
      lesson: { ...LESSON, failure: "bun test --test-name-pattern tsc" },
    });
    expect((await loadAll()).find((r) => r.scope === "cart")).toBeDefined();
  });

  test("a credential in a failing command's args never reaches the prompt", async () => {
    // Review #384 finding 1: attested entries were built from RAW ledger args.
    // The transcript scrub does not cover this input, so the ATTESTED FAILURES
    // block carried the token verbatim.
    const TOKEN = "sk-abcdefghij0123456789";
    await capture("lesson-redact", true, {
      failingCmd: `bun test --token=${TOKEN}`,
      // The honest copy: what the model was shown is the redacted entry, and
      // the citation check compares against that same representation.
      lesson: { ...LESSON, failure: "bun test --token=[redacted]" },
    });
    const prompt = String(plugin?.capture.generate.calls[0]?.prompt ?? "");
    expect(prompt).toContain("ATTESTED FAILURES");
    expect(prompt).not.toContain(TOKEN);
    expect(prompt).toContain("[redacted]");
    // The citation is checked against the SAME redacted string the model was
    // shown, so an honest copy still passes.
    expect((await loadAll()).find((r) => r.scope === "cart")).toBeDefined();
  });

  test("an uncited blocker keeps today's behaviour — no recall loss", async () => {
    // `blocker` is an existing type and capture already writes ordinary
    // obstacle notes with it. Requiring a citation on EVERY blocker would
    // silently delete rows that store has always kept, and this plugin's own
    // rule is that a provenance fix must not buy a recall loss. So the gate is
    // monotone: carrying a `failure` is what claims "this is a lesson", and
    // only that claim is checked. An uncited blocker is today's row.
    const sid = "lesson-uncited";
    const repo = join(fixture.root, `repo-${sid}`);
    mkdirSync(repo, { recursive: true });
    plugin = await loadPlugin(repo, {
      autoCapture: true,
      captureModel: "fake/model",
    });
    await plugin["tool.execute.after"](
      {
        tool: "edit",
        sessionID: sid,
        callID: `${sid}-edit`,
        args: { filePath: "src/cart.ts" },
      },
      { output: "edited", metadata: {} },
    );
    plugin.capture.context.messages = [
      {
        role: "user",
        content:
          "Fix the cart totals across the warehouse merge path so the suite goes green again.".repeat(
            3,
          ),
      },
    ];
    const { failure: _drop, ...uncited } = LESSON;
    plugin.capture.generate.response = JSON.stringify([uncited]);
    plugin.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: sid },
    });
    const deadline = Date.now() + 6000;
    while (
      !readEvidenceLog().some(
        (event) => event.ev === "capture_lag" && event.session === sid,
      )
    ) {
      if (Date.now() >= deadline) throw new Error("capture did not complete");
      await Bun.sleep(5);
    }
    expect((await loadAll()).find((r) => r.scope === "cart")).toBeDefined();
  });

  test("a lesson citing a failure that already recovered is refused", async () => {
    const sid = "lesson-recovered";
    const repo = join(fixture.root, `repo-${sid}`);
    mkdirSync(repo, { recursive: true });
    plugin = await loadPlugin(repo, {
      autoCapture: true,
      captureModel: "fake/model",
    });
    await plugin["tool.execute.after"](
      {
        tool: "edit",
        sessionID: sid,
        callID: `${sid}-edit`,
        args: { filePath: "src/cart.ts" },
      },
      { output: "edited", metadata: {} },
    );
    // Red, then green: the agent fixed it, so "avoid this" is not a lesson.
    for (const [callID, exit, output] of [
      [`${sid}-t1`, 1, "(fail) cart > total [2ms]\n1 fail"],
      [`${sid}-t2`, 0, "2 pass\n0 fail"],
    ] as const)
      await plugin["tool.execute.after"](
        {
          tool: "bash",
          sessionID: sid,
          callID,
          args: { command: "bun test ./src/cart.test.ts" },
        },
        { output, metadata: { exit } },
      );
    plugin.capture.context.messages = [
      {
        role: "user",
        content:
          "Fix the cart totals across the warehouse merge path so the suite goes green again.".repeat(
            3,
          ),
      },
    ];
    plugin.capture.generate.response = JSON.stringify([LESSON]);
    plugin.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: sid },
    });
    const deadline = Date.now() + 6000;
    while (
      !readEvidenceLog().some(
        (event) => event.ev === "capture_lag" && event.session === sid,
      )
    ) {
      if (Date.now() >= deadline) throw new Error("capture did not complete");
      await Bun.sleep(5);
    }
    expect((await loadAll()).find((r) => r.scope === "cart")).toBeUndefined();
  });

  test("an ordinary row is unaffected by the lesson rule", async () => {
    const sid = "lesson-plain";
    const repo = join(fixture.root, `repo-${sid}`);
    mkdirSync(repo, { recursive: true });
    plugin = await loadPlugin(repo, {
      autoCapture: true,
      captureModel: "fake/model",
    });
    await plugin["tool.execute.after"](
      {
        tool: "edit",
        sessionID: sid,
        callID: `${sid}-edit`,
        args: { filePath: "src/cart.ts" },
      },
      { output: "edited", metadata: {} },
    );
    plugin.capture.context.messages = [
      {
        role: "user",
        content:
          "We build this package with bun build and ship the dist folder to the CDN origin.".repeat(
            3,
          ),
      },
    ];
    plugin.capture.generate.response = JSON.stringify([
      {
        type: "learning",
        scope: "build",
        content:
          "This package is built with bun build and dist is shipped to the CDN.",
      },
    ]);
    plugin.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: sid },
    });
    const deadline = Date.now() + 6000;
    while (
      !readEvidenceLog().some(
        (event) => event.ev === "capture_lag" && event.session === sid,
      )
    ) {
      if (Date.now() >= deadline) throw new Error("capture did not complete");
      await Bun.sleep(5);
    }
    expect((await loadAll()).find((r) => r.scope === "build")).toBeDefined();
  });
});
