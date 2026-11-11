// Contract (#389): capture spends its budget on facts the next session cannot
// obtain any other way, and declines what it can read or re-derive.
//
// The discriminator came from measurement, not taste (FINDINGS 2026-11-10):
// reuse pays nothing (six pairs, median L2/L0 0.98x) while transport pays
// everything (empty store 0/5, seeded 5/5). What separates the two is whether
// the next session could get the fact by itself. So availability is answered by
// a CODE PATH — no prompt, no model call — and it only ever REFUSES. It never
// deletes: the check runs before the write gate, so a row the store has always
// kept survives a refused candidate (criterion 6).
//
// Fail-open is the contract on every uncertainty. A missing git, a non-repo
// workspace, or an unreadable file is not evidence that a fact is available, and
// refusing on those would spend the one measured benefit capture has.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetCaptureCooldowns, resetSessionModels } from "../src/index.ts";
import { loadAll } from "../src/store/files/load.ts";
import { loadPlugin, withTempStore } from "./harness.ts";
import { readEvidenceLog } from "./helpers/logfmt.ts";

const README_TEXT =
  "Reorder is inclusive: needsReorder returns true when available stock is at or below reorderPoint, not only strictly below.";

function git(dir: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${p.stderr?.toString()}`);
}

async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("capture did not finish");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const fixture = withTempStore({ prefix: "osi-capture-avail-" });

describe("capture availability gate (#389)", () => {
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | undefined;

  /** A git repo whose tracked tree states the tax rule and declares `test`. */
  function makeRepo(name: string, tracked = true): string {
    const repo = join(fixture.root, name);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), `# Reorder\n\n${README_TEXT}\n`);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify(
        { name: "fixture", scripts: { deploy: "rsync dist/ box:/srv" } },
        null,
        2,
      ),
    );
    if (tracked) {
      git(repo, "init", "-q");
      git(repo, "add", ".");
    }
    return repo;
  }

  async function capture(
    repo: string,
    candidates: unknown[],
    sid = "ses-avail",
  ): Promise<void> {
    plugin = await loadPlugin(repo, {
      autoCapture: true,
      captureModel: "fake/model",
    });
    // Engagement: the gate's grounding rules need the session to have exercised
    // code, or every candidate is refused for the OLDER reason and this file
    // would prove nothing about availability.
    await plugin["tool.execute.after"](
      {
        tool: "read",
        sessionID: sid,
        callID: "read",
        args: { filePath: "src/x.ts" },
      },
      { output: "observed source", metadata: {} },
    );
    // Substantial or the trigger skips the pass before the model call
    // (transcript_too_thin), and nothing below this line would be exercised.
    plugin.capture.context.messages = [
      {
        role: "user",
        content:
          `Fix the reorder path and the release script. Reorder is inclusive, needsReorder returns true at or below reorderPoint. ` +
          `The deploy step rsyncs dist to the box and restarts the container. ` +
          `Check the staging rate limit too, and pace the importer. ` +
          `Run the suite before you finish and report what changed.`.repeat(2),
      },
    ];
    plugin.capture.generate.response = JSON.stringify(candidates);
    plugin.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: sid },
    });
    await waitFor(() =>
      readEvidenceLog().some((l) => String(l.session) === sid),
    );
    // Let every candidate's receipt land, not just the first.
    await new Promise((r) => setTimeout(r, 250));
  }

  const evidence = () => readEvidenceLog();
  const rowsWith = async (scope: string) =>
    (await loadAll()).filter((m) => m.scope === scope);

  beforeEach(() => {
    resetCaptureCooldowns();
    resetSessionModels();
  });
  afterEach(async () => {
    await plugin?.cleanup();
    plugin = undefined;
  });

  test("a candidate that restates a tracked file is refused, with the file named", async () => {
    await capture(makeRepo("restated"), [
      {
        type: "learning",
        scope: "inventory",
        content: README_TEXT,
      },
    ]);
    const refused = evidence().filter((l) => l.ev === "auto_capture_available");
    expect(refused.length).toBe(1);
    expect(String(refused[0].reason)).toBe("in_tracked_file");
    expect(String(refused[0].where)).toBe("README.md");
    expect((await rowsWith("inventory")).length).toBe(0);
  });

  test("near-verbatim still refuses: case, wrapping and backticks are formatting", async () => {
    await capture(makeRepo("near"), [
      {
        type: "learning",
        scope: "inventory",
        content: README_TEXT.replace(/ /g, "\n  ").replace(
          "needsReorder",
          "`needsReorder`",
        ),
      },
    ]);
    const refused = evidence().filter((l) => l.ev === "auto_capture_available");
    expect(refused.length).toBe(1);
    expect(String(refused[0].reason)).toBe("in_tracked_file");
  });

  test("a command the project declares is refused, with the gate named", async () => {
    await capture(makeRepo("gate"), [
      {
        type: "pattern",
        scope: "release",
        content: "Ship this repo with `npm run deploy` from the root.",
      },
    ]);
    const refused = evidence().filter((l) => l.ev === "auto_capture_available");
    expect(refused.length).toBe(1);
    expect(String(refused[0].reason)).toBe("declared_gate");
    expect(String(refused[0].where)).toContain("package.json scripts.deploy");
    expect((await rowsWith("release")).length).toBe(0);
  });

  test("a fact that is nowhere in the tree is kept — this is the transport case", async () => {
    await capture(makeRepo("transport"), [
      {
        type: "learning",
        scope: "staging",
        content:
          "The staging API rate limit is 120 requests per minute per key; importers must pace at 2/s or they get 429s.",
      },
    ]);
    expect(evidence().some((l) => l.ev === "auto_capture_available")).toBe(
      false,
    );
    expect((await rowsWith("staging")).length).toBe(1);
  });

  test("a workspace that is not a git repo keeps everything: no git is no evidence", async () => {
    await capture(makeRepo("plain", false), [
      { type: "learning", scope: "inventory", content: README_TEXT },
    ]);
    expect(evidence().some((l) => l.ev === "auto_capture_available")).toBe(
      false,
    );
    expect((await rowsWith("inventory")).length).toBe(1);
  });

  test("a short gate name does not refuse prose that merely contains it", async () => {
    const repo = join(fixture.root, "single-word");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "Makefile"), "all:\n\techo built\n");
    git(repo, "init", "-q");
    git(repo, "add", ".");
    await capture(repo, [
      {
        type: "pattern",
        scope: "setup",
        content:
          "Install all dependencies with `pnpm install` before the first run.",
      },
    ]);
    expect(evidence().some((l) => l.ev === "auto_capture_available")).toBe(
      false,
    );
    expect((await rowsWith("setup")).length).toBe(1);
  });

  test("refusing a restatement never deletes a row the store already kept", async () => {
    const repo = makeRepo("monotone");
    // A row the store has always kept, on the same scope the candidate targets.
    const { appendFileSync } = await import("node:fs");
    const { memoryRoot } = await import("../src/core/config/paths.ts");
    const { formatLine } = await import("../src/core/logfmt/format.ts");
    const ts = "2026-10-01T09:00:00.000Z";
    const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
    mkdirSync(join(memoryRoot()), { recursive: true });
    appendFileSync(
      file,
      formatLine({
        ts,
        type: "learning",
        scope: "inventory",
        content: "The kept row: reorder uses a strict less-than compare.",
        status: "settled",
      }) + "\n",
    );
    await capture(repo, [
      { type: "learning", scope: "inventory", content: README_TEXT },
    ]);
    expect(evidence().some((l) => l.ev === "auto_capture_available")).toBe(
      true,
    );
    const kept = await rowsWith("inventory");
    expect(kept.length).toBe(1);
    expect(kept[0]?.content).toContain("The kept row");
    // A refusal writes no supersession and no blocklist entry.
    expect(
      evidence().some((l) => String(l.ev ?? "").includes("supersede")),
    ).toBe(false);
  });

  test("refusal lowers rows, not tokens: the model call is already paid for", async () => {
    // Criterion 4 of #389 expected capture's token cost to fall. It cannot.
    // Candidates come FROM the model, so availability can only be evaluated
    // after the call that produced them: the gate changes how many rows reach
    // the store, never how many tokens the pass spent. Pinned rather than
    // argued, so a future cost claim about this mechanism has to move a test
    // instead of re-deriving the assumption. Lowering the token cost means
    // changing WHEN the pass runs (triggers, cooldown), not what it keeps.
    const repo = makeRepo("cost");
    plugin = await loadPlugin(repo, {
      autoCapture: true,
      captureModel: "fake/model",
    });
    await plugin["tool.execute.after"](
      {
        tool: "read",
        sessionID: "ses-cost",
        callID: "read",
        args: { filePath: "src/x.ts" },
      },
      { output: "observed source", metadata: {} },
    );
    plugin.capture.context.messages = [
      {
        role: "user",
        content:
          "Fix the reorder path. Reorder is inclusive, needsReorder returns true at or below reorderPoint. " +
          "Also note the staging rate limit and pace the importer, and ship with npm run deploy.".repeat(
            2,
          ),
      },
    ];
    plugin.capture.generate.response = JSON.stringify([
      { type: "learning", scope: "inventory", content: README_TEXT },
      {
        type: "pattern",
        scope: "release",
        content: "Ship with `npm run deploy`.",
      },
      {
        type: "learning",
        scope: "staging",
        content:
          "The staging API rate limit is 120 requests per minute per key; importers must pace at 2/s or they get 429s.",
      },
    ]);
    plugin.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-cost" },
    });
    await waitFor(() =>
      readEvidenceLog().some((l) => String(l.session) === "ses-cost"),
    );
    await new Promise((r) => setTimeout(r, 300));
    // One call, whatever the verdict — the same call a no-gate pass would make.
    expect(plugin.capture.generate.calls.length).toBe(1);
    // Two of three refused as restatable; the unavailable fact still lands.
    expect(
      readEvidenceLog().filter((l) => l.ev === "auto_capture_available").length,
    ).toBe(2);
    expect((await rowsWith("staging")).length).toBe(1);
  });

  test("a guided row that contradicts the tree is not refused as restatable", async () => {
    // The case that matters: the user corrects a stale doc. A contradiction is
    // by definition not verbatim in the file, so availability cannot see it —
    // and the row must survive to be code-checked by the conflict surface.
    await capture(makeRepo("contradiction"), [
      {
        type: "learning",
        scope: "inventory",
        content:
          "Reorder is NOT inclusive: needsReorder returns true only when stock is strictly below reorderPoint.",
        guided: true,
      },
    ]);
    expect(evidence().some((l) => l.ev === "auto_capture_available")).toBe(
      false,
    );
    expect((await rowsWith("inventory")).length).toBe(1);
  });
});
