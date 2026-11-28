// Contract: capture REFUSES what the next session can read
// in the working tree, and keeps everything else.
//
// The discriminator comes from measurement, not taste: reuse pays nothing while
// transport pays everything — an empty store 0/5, the same store seeded 5/5.
// What separates the two is whether the next session could get the fact by
// itself, so a candidate whose every assertion the tracked tree states, or
// whose only content is a command the project declares, is refused — and the
// refusal line names the file or the gate.
//
// The refusal is the hardened matcher's, not a fragment rule's: it fires only
// when every claim is restatable verbatim modulo formatting, in a sentence of
// the same polarity, with no figure the tree does not carry, and with the
// claims contiguous in the tree rather than assembled from separate lines.
// History: docs/adr/.
//
// So the tests split on one axis: a restatable candidate produces a refusal
// line and NO row, and every other candidate — a restriction on a declared
// command, a new figure, a dropped negation, a fact the tree does not hold —
// produces a row exactly as before. The kept cases pin the transport result
// from the other side: the store must keep what only the store can carry.
//
// Fail-open is still the contract on every uncertainty. A missing git, a non-repo
// workspace, or an unreadable file is not evidence that a fact is available, and
// acting on those would spend the one measured benefit capture has.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../../src/core/config/paths.ts";
import { RESTATABLE_TAG } from "../../src/core/tags.ts";
import { dateStr } from "../../src/core/time.ts";
import { resetCaptureCooldowns, resetSessionModels } from "../../src/index.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { loadPlugin, withTempStore } from "../harness.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";

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

describe("capture availability refusal", () => {
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | undefined;

  afterEach(async () => {
    await plugin?.cleanup();
    plugin = undefined;
  });

  /** A git repo whose tracked tree states the tax rule and declares `deploy`. */
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

  // Each pass gets its OWN session. Capture keeps a per-session window cursor,
  // and every case here drives the same transcript: sharing one id makes pass N+1
  // see a zero-length window and return before it records anything, so the case
  // times out for a reason that has nothing to do with availability.
  let seq = 0;
  async function capture(
    repo: string,
    candidates: unknown[],
    sid?: string,
  ): Promise<string> {
    sid = sid ?? `ses-avail-${++seq}`;
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
    // The terminal receipt follows every candidate's write or refusal. An early
    // receipt only proves the pass started and can precede all stored rows.
    await waitFor(() =>
      readEvidenceLog().some(
        (l) => l.ev === "capture_lag" && String(l.session) === sid,
      ),
    );
    return sid;
  }

  const evidence = () => readEvidenceLog();
  const rowsWith = async (scope: string) =>
    (await loadAll()).filter((m) => m.scope === scope);
  /** The refusal line for one scope. */
  const refusalFor = (scope: string) =>
    evidence().filter(
      (l) => l.ev === "auto_capture_restatable" && String(l.scope) === scope,
    );

  // ── The provable forms refuse: a line per candidate, no row ────────────────

  test("an all-restatable batch is refused, with a line per candidate", async () => {
    await capture(makeRepo("invariant"), [
      { type: "learning", scope: "av-inv1", content: README_TEXT },
      {
        type: "pattern",
        scope: "av-inv2",
        content: "Ship with `npm run deploy`.",
      },
      {
        type: "learning",
        scope: "av-inv3",
        // The tree's colon-split assertion stated WHOLE. The fragment
        // "needsReorder returns true" without its "at or below" condition is
        // a new claim, not a restatement, and is no longer refused.
        content: "Reorder is inclusive.",
      },
    ]);
    for (const scope of ["av-inv1", "av-inv2", "av-inv3"]) {
      expect(refusalFor(scope).length).toBe(1);
      expect((await rowsWith(scope)).length).toBe(0);
    }
  });

  // ── The two provable forms, named in the refusal ───────────────────────────

  test("a candidate that restates a tracked file is refused, with the file named", async () => {
    await capture(makeRepo("restated"), [
      {
        type: "learning",
        scope: "av-restated",
        content: README_TEXT,
      },
    ]);
    const refused = refusalFor("av-restated");
    expect(refused.length).toBe(1);
    expect(String(refused[0].reason)).toBe("in_tracked_file");
    expect(String(refused[0].where)).toBe("README.md");
    // The tree states the fact, so the store does not need a second copy.
    expect((await rowsWith("av-restated")).length).toBe(0);
    // The audit line carries the whole candidate, so it alone can rebuild it.
    expect(String(refused[0].content)).toContain("needsReorder");
  });

  test("near-verbatim is still caught: case, wrapping and backticks are formatting", async () => {
    await capture(makeRepo("near"), [
      {
        type: "learning",
        scope: "av-near",
        content: README_TEXT.replace(/ /g, "\n  ").replace(
          "needsReorder",
          "`needsReorder`",
        ),
      },
    ]);
    expect(refusalFor("av-near").length).toBe(1);
    expect(String(refusalFor("av-near")[0].reason)).toBe("in_tracked_file");
    expect((await rowsWith("av-near")).length).toBe(0);
  });

  test("a command the project declares is refused, with the gate named", async () => {
    // The bare mention is the case the manifest can actually answer. Prose
    // riding the command is a claim the manifest does not make, so it is kept;
    // see the gate-claim test below.
    await capture(makeRepo("gate"), [
      {
        type: "pattern",
        scope: "release",
        content: "Ship with `npm run deploy`.",
      },
    ]);
    const refused = refusalFor("release");
    expect(refused.length).toBe(1);
    expect(String(refused[0].reason)).toBe("declared_gate");
    expect(String(refused[0].where)).toContain("package.json scripts.deploy");
    expect((await rowsWith("release")).length).toBe(0);
  });

  // ── What the matcher must NOT refuse ───────────────────────────────────────

  test("a restriction ON a declared command is new information — kept", async () => {
    // Reproduced: merely finding a declared command does not
    // establish that a new instruction about WHEN to avoid it is available.
    // The approval code and the restriction appear nowhere in the tree.
    await capture(makeRepo("gate-restriction"), [
      {
        type: "blocker",
        scope: "release2",
        content:
          "Never run `npm run deploy` until finance confirms approval code BLUEBIRD.",
      },
    ]);
    expect(refusalFor("release2")).toHaveLength(0);
    const rows = await rowsWith("release2");
    expect(rows.length).toBe(1);
    expect(rows[0]?.tags ?? []).not.toContain(RESTATABLE_TAG);
  });

  test("a restated clause carrying a new clause is kept", async () => {
    // One old clause matching must not refuse the whole row and hide
    // the unavailable fact riding it.
    await capture(makeRepo("mixed"), [
      {
        type: "learning",
        scope: "mixed",
        content: `${README_TEXT} Finance confirmed the external supplier rate is 1900 basis points.`,
      },
    ]);
    expect(refusalFor("mixed")).toHaveLength(0);
    expect((await rowsWith("mixed")).length).toBe(1);
  });

  test("a SHORT restriction on a declared command is kept", async () => {
    // The residual after the command span is
    // stripped is 27 characters, and the whole fact is in it. The manifest
    // declares that `deploy` exists; it declares nothing about approval.
    await capture(makeRepo("gate-short"), [
      {
        type: "blocker",
        scope: "release4",
        content: "Never run `npm run deploy` without approval.",
      },
    ]);
    expect(refusalFor("release4")).toHaveLength(0);
    expect((await rowsWith("release4")).length).toBe(1);
  });

  test("a restated clause carrying a SHORT new clause is kept", async () => {
    // The new clause sits below any length threshold worth naming, so a
    // matcher that dropped short fragments would refuse on the old clause
    // alone. A short clause can carry the entire new number.
    await capture(makeRepo("mixed-short"), [
      {
        type: "learning",
        scope: "mixed2",
        content: `${README_TEXT}; External rate is 1900.`,
      },
    ]);
    expect(refusalFor("mixed2")).toHaveLength(0);
    expect((await rowsWith("mixed2")).length).toBe(1);
  });

  test("a declared command does not swallow a new behavioural fact", async () => {
    // Reproduced: the residual left by the command strip was
    // 26 characters and carried no restriction word, so its LENGTH alone was
    // taken as proof of a restatement. The manifest declares that `deploy` runs
    // `rsync dist/ box:/srv`. It says nothing about the staging database and
    // nothing about Windows, and no list of condition words can cover what it
    // does not say.
    await capture(makeRepo("gate-claim"), [
      {
        type: "learning",
        scope: "release5",
        content: "`npm run deploy` wipes the staging database.",
      },
      {
        type: "learning",
        scope: "release6",
        content: "`npm run deploy` fails on Windows; use WSL.",
      },
    ]);
    expect(refusalFor("release5")).toHaveLength(0);
    expect(refusalFor("release6")).toHaveLength(0);
    expect((await rowsWith("release5")).length).toBe(1);
    expect((await rowsWith("release6")).length).toBe(1);
  });

  test("nothing is discarded before the refusal is decided", async () => {
    // Two gaps a fragment-dropping matcher opens:
    //   - `assertions()` dropped every fragment under 16 characters, so the only
    //     claim in "Never `npm run deploy`." was erased and the empty list was
    //     then read as proof the whole row was restatable;
    //   - the residual stripped EVERY command span after finding ONE declared
    //     gate, so the undeclared `aws sso login` prerequisite in the second row
    //     was erased the same way.
    // The third candidate is the same length cutoff on the other rule: a
    // 5-character prohibition riding a restated README sentence.
    await capture(makeRepo("gate-discarded"), [
      {
        type: "blocker",
        scope: "release7",
        content: "Never `npm run deploy`.",
      },
      {
        type: "learning",
        scope: "release8",
        content: "Before `npm run deploy`, run `aws sso login --profile prod`.",
      },
      {
        type: "learning",
        scope: "mixed3",
        content: `${README_TEXT}; never.`,
      },
    ]);
    expect(refusalFor("release7")).toHaveLength(0);
    expect(refusalFor("release8")).toHaveLength(0);
    expect(refusalFor("mixed3")).toHaveLength(0);
    expect((await rowsWith("release7")).length).toBe(1);
    expect((await rowsWith("release8")).length).toBe(1);
    expect((await rowsWith("mixed3")).length).toBe(1);
  });

  test("a substring of the OPPOSITE rule is not a restatement", async () => {
    // The clause lookup must not match `Use tabs for
    // indentation.` INSIDE `We do not use tabs for indentation.`. That is the
    // worst failure this check can have: it would refuse the correction and
    // leave the doc's authority behind the reversed rule. A match has to sit
    // in a sentence of the same polarity — and the verbatim negated rule is
    // still refused, so the guard did not simply switch the check off.
    const repo = join(fixture.root, "negated");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "README.md"),
      "We do not use tabs for indentation.\n",
    );
    git(repo, "init", "-q");
    git(repo, "add", ".");
    await capture(repo, [
      {
        type: "learning",
        scope: "style",
        content: "Use tabs for indentation.",
        guided: true,
      },
      {
        type: "learning",
        scope: "style2",
        content: "We do not use tabs for indentation.",
      },
    ]);
    // Scoped, not global: other cases in this file refuse rows too.
    expect(refusalFor("style")).toHaveLength(0);
    const refused = refusalFor("style2");
    expect(refused.length).toBe(1);
    expect(String(refused[0].reason)).toBe("in_tracked_file");
    // The correction is kept; the verbatim restatement is not written.
    const style = await rowsWith("style");
    expect(style.length).toBe(1);
    expect(style[0]?.tags ?? []).not.toContain(RESTATABLE_TAG);
    expect((await rowsWith("style2")).length).toBe(0);
  });

  test("a figure the declaration does not carry is a different fact (veto 2)", async () => {
    // `core/tokenize.ts`: a changed number is a different fact, not a rephrasing.
    // The manifest says `deploy` runs rsync; it states no count, so "3 times" is
    // new even though every word around the command is filler.
    await capture(makeRepo("new-number"), [
      {
        type: "pattern",
        scope: "release9",
        content: "Ship with `npm run deploy`, 3 times.",
      },
    ]);
    expect(refusalFor("release9")).toHaveLength(0);
    expect((await rowsWith("release9")).length).toBe(1);
  });

  // ── Fail-open: no evidence means no refusal ────────────────────────────────

  test("a fact that is nowhere in the tree is kept — this is the transport case", async () => {
    await capture(makeRepo("transport"), [
      {
        type: "learning",
        scope: "av-staging",
        content:
          "The staging API rate limit is 120 requests per minute per key; importers must pace at 2/s or they get 429s.",
      },
    ]);
    expect(refusalFor("av-staging")).toHaveLength(0);
    expect((await rowsWith("av-staging")).length).toBe(1);
  });

  test("a workspace that is not a git repo refuses nothing: no git is no evidence", async () => {
    await capture(makeRepo("plain", false), [
      { type: "learning", scope: "av-plain", content: README_TEXT },
    ]);
    expect(refusalFor("av-plain")).toHaveLength(0);
    expect((await rowsWith("av-plain")).length).toBe(1);
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
    expect(refusalFor("setup")).toHaveLength(0);
    expect((await rowsWith("setup")).length).toBe(1);
  });

  // ── Monotonicity and cost ──────────────────────────────────────────────────

  test("refusing a restatement never deletes a row the store already kept", async () => {
    const repo = makeRepo("monotone");
    // A row the store has always kept, on the same scope the candidate targets.
    const { appendFileSync } = await import("node:fs");
    const { memoryRoot } = await import("../../src/core/config/paths.ts");
    const { formatLine } = await import("../../src/core/logfmt/format.ts");
    const ts = "2026-10-01T09:00:00.000Z";
    const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
    mkdirSync(join(memoryRoot()), { recursive: true });
    appendFileSync(
      file,
      formatLine({
        ts,
        type: "learning",
        scope: "av-mono",
        content: "The kept row: reorder uses a strict less-than compare.",
        status: "settled",
      }) + "\n",
    );
    await capture(repo, [
      { type: "learning", scope: "av-mono", content: README_TEXT },
    ]);
    expect(refusalFor("av-mono")).toHaveLength(1);
    // The pre-existing row survives untouched and the refused candidate adds
    // nothing. Refusal acts on candidates, never on what the store holds;
    // consolidation is the only thing that retires a row, and it needs proven
    // reads (`consolidate/propose.ts`), which availability does not have.
    const kept = await rowsWith("av-mono");
    expect(kept.length).toBe(1);
    expect(kept.some((m) => m.content.includes("The kept row"))).toBe(true);
    // A refusal writes no supersession and no blocklist entry.
    expect(
      evidence().some((l) => String(l.ev ?? "").includes("supersede")),
    ).toBe(false);
  });

  test("refusal lowers stored rows, not the model call", async () => {
    // Capture's own token cost cannot fall here: candidates come FROM the
    // model, so availability can only be evaluated after the call that
    // produced them. What falls is what the pass leaves behind — refused
    // candidates never become rows, so the store and every later injection
    // block shrink. Pinned in both directions, so a future cost claim about
    // this mechanism has to move a test instead of re-deriving the
    // assumption: one model call whatever the verdicts, and two of three
    // candidates refused.
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
      { type: "learning", scope: "av-cost-inv", content: README_TEXT },
      {
        type: "pattern",
        scope: "av-cost-rel",
        content: "Ship with `npm run deploy`.",
      },
      {
        type: "learning",
        scope: "av-cost-stg",
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
    // One call, whatever the verdict — the same call a no-check pass would make.
    expect(plugin.capture.generate.calls.length).toBe(1);
    // Two of three refused as restatements; only the tree-silent fact is kept.
    expect(
      readEvidenceLog().filter((l) => l.ev === "auto_capture_restatable")
        .length,
    ).toBe(2);
    for (const scope of ["av-cost-inv", "av-cost-rel"])
      expect((await rowsWith(scope)).length).toBe(0);
    expect((await rowsWith("av-cost-stg")).length).toBe(1);
  });

  test("a guided row that contradicts the tree is not refused as restatable", async () => {
    // The case that matters: the user corrects a stale doc. A contradiction is
    // by definition not verbatim in the file, so availability cannot see it —
    // and the row must survive to be code-checked by the conflict surface.
    await capture(makeRepo("contradiction"), [
      {
        type: "learning",
        scope: "av-contra",
        content:
          "Reorder is NOT inclusive: needsReorder returns true only when stock is strictly below reorderPoint.",
        guided: true,
      },
    ]);
    expect(refusalFor("av-contra")).toHaveLength(0);
    const rows = await rowsWith("av-contra");
    expect(rows.length).toBe(1);
    expect(rows[0]?.tags ?? []).not.toContain(RESTATABLE_TAG);
  });

  test("a guided candidate that restates the tree is refused too", async () => {
    // The recall layer exempts guided rows from the budget demotion; that
    // exemption does not extend upstream. A guided verbatim copy rides every
    // later injection block at full rank — exactly the row class this
    // refusal removes — so capture refuses it as well, and the refusal line
    // marks it guided so the decision stays visible and replayable.
    await capture(makeRepo("guided-restated"), [
      {
        type: "learning",
        scope: "av-guided-copy",
        content: README_TEXT,
        guided: true,
      },
    ]);
    const refused = refusalFor("av-guided-copy");
    expect(refused.length).toBe(1);
    expect(String(refused[0].guided)).toBe("true");
    expect(String(refused[0].reason)).toBe("in_tracked_file");
    expect((await rowsWith("av-guided-copy")).length).toBe(0);
  });

  test("a corrected figure is not a restatement of the figures beside it", async () => {
    // The tree states `1` and `5`; the candidate states `1.5`. Fragment
    // matching alone calls that restatable — each piece matches its own
    // sentence — and refuses the corrected number, which is the transport
    // class: the fact the store exists to carry. The refusal requires every
    // figure the candidate states to appear in the tree as a whole token.
    const repo = join(fixture.root, "corrected-figure");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "README.md"),
      "# Budget\n\nThe budget is 1 second per call. Retry after 5 seconds.\n",
    );
    git(repo, "init", "-q");
    git(repo, "add", ".");
    await capture(repo, [
      {
        type: "learning",
        scope: "av-fig-15",
        content: "The budget is 1.5 seconds.",
      },
    ]);
    expect(refusalFor("av-fig-15")).toHaveLength(0);
    expect((await rowsWith("av-fig-15")).length).toBe(1);
  });

  test("a label and a value stated by different lines are not one restatement", async () => {
    // Reported as a transport loss: the tree pairs `cobalt-workers` with
    // Staging and `ask operations at rollout` with Production, so the pairing
    // in the candidate is the session's own fact. Each half exists somewhere,
    // which is exactly what an independent per-claim match cannot see; the
    // refusal requires the halves to be contiguous in the tree.
    const repo = join(fixture.root, "cross-line-pair");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "README.md"),
      "Staging export pool: cobalt-workers.\nProduction export pool: ask operations at rollout.\n",
    );
    git(repo, "init", "-q");
    git(repo, "add", ".");
    await capture(repo, [
      {
        type: "learning",
        scope: "av-pair",
        content: "Production export pool: cobalt-workers.",
      },
    ]);
    expect(refusalFor("av-pair")).toHaveLength(0);
    expect((await rowsWith("av-pair")).length).toBe(1);
  });

  test("a forwarded argument the declaration omits is not part of the command", async () => {
    // Reported as a transport loss: stripping the command span before reading
    // the residual took `-- --target canary` with it, so this row earned the
    // same `declared_gate` verdict as the bare invocation while carrying the
    // one fact the session brought. The declaration is the script AND its
    // command; a word neither states declines the refusal.
    const repo = join(fixture.root, "forwarded-arg");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "# widget\n\nNothing here.\n");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { deploy: "deploy-tool publish" } }),
    );
    git(repo, "init", "-q");
    git(repo, "add", ".");
    await capture(repo, [
      {
        type: "learning",
        scope: "av-canary",
        content: "Run `npm run deploy -- --target canary`.",
      },
    ]);
    expect(refusalFor("av-canary")).toHaveLength(0);
    expect((await rowsWith("av-canary")).length).toBe(1);
  });

  test("a sibling workflow step does not vouch for a flag", async () => {
    // Every `run:` in a workflow file shares one declaration site, so the
    // union that let a neighbouring step vouch for a word made
    // `npm run build --prod` look declared when only the push step uses
    // `--prod`. The flag combination is what the session observed.
    const repo = join(fixture.root, "workflow-sibling");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "# widget\n\nNothing here.\n");
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(repo, ".github/workflows/ci.yml"),
      "name: ci\non: push\njobs:\n  a:\n    steps:\n      - run: npm run build\n      - run: docker push app --prod\n",
    );
    git(repo, "init", "-q");
    git(repo, "add", ".");
    await capture(repo, [
      {
        type: "learning",
        scope: "av-wf-flag",
        content: "Run `npm run build --prod`.",
      },
    ]);
    expect(refusalFor("av-wf-flag")).toHaveLength(0);
    expect((await rowsWith("av-wf-flag")).length).toBe(1);
  });

  test("a dual-role verb does not mask a scope negation", async () => {
    // The union of the cue list with `polaritySigns` was applied to BOTH sides of
    // the polarity comparison in `findClause`, and that comparison CREATES
    // refusals. `polaritySigns` reads the dual-role `removes` as negative in both
    // strings, so the affirmative claim agreed with the sentence warning against
    // it and would be refused as restating it — the reversal, arriving from the
    // opposite direction. The comparison now uses the cue list alone; the union
    // stays where the answer is absolute.
    const repo = join(fixture.root, "dual-role");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      repo + "/README.md",
      "# T\n\nDo not assume the cleaner removes unused rows.\n",
    );
    git(repo, "init", "-q");
    git(repo, "add", ".");
    await capture(
      repo,
      [
        {
          type: "learning",
          scope: "av-dual",
          content: "The cleaner removes unused rows.",
        },
      ],
      "ses-dual",
    );
    const rows = await rowsWith("av-dual");
    // The row is kept — the matcher declined — and it carries no refusal.
    expect(rows.length).toBe(1);
    expect(rows[0]?.tags ?? []).not.toContain(RESTATABLE_TAG);
    expect(refusalFor("av-dual")).toHaveLength(0);
  });

  test("the polarity union still declines a command the prose drops", async () => {
    // The other half: the union is load-bearing where the answer is absolute.
    // "Drop using" carries no cue-list negation, and `polaritySigns` reads `drop`
    // as negative, so the manifest's declaration is refused as evidence. Narrowing
    // the union everywhere would have re-opened that.
    await capture(
      makeRepo("union-kept"),
      [
        {
          type: "learning",
          scope: "av-union",
          content: "Drop using `npm run deploy` from the loop.",
        },
      ],
      "ses-union",
    );
    const rows = await rowsWith("av-union");
    expect(rows.length).toBe(1);
    expect(rows[0]?.tags ?? []).not.toContain(RESTATABLE_TAG);
  });

  test("a control character in a candidate does not reach the audit line raw", async () => {
    // The candidate is a verbatim declared-command claim with a NUL appended: the
    // availability matcher accepts it, because `norm()` neither strips nor requires
    // the control character. Nothing between that verdict and the day log
    // sanitises it — `scrubFields` only redacts credentials, and the logfmt writer
    // escapes five characters. `memory_evidence` then returns the line to a model.
    const sid = await capture(
      makeRepo("ctl-chars"),
      [
        {
          type: "pattern",
          scope: "av-ctl",
          content: "Ship with `npm run deploy`.\u0000",
        },
      ],
      "ses-ctl",
    );
    const line = readEvidenceLog().find(
      (l) => l.ev === "auto_capture_restatable" && String(l.session) === sid,
    );
    // Without this, every assertion below passes on a pass that recorded nothing.
    expect(line).toBeDefined();
    const C = /[\p{Cc}\p{Zl}\p{Zp}]/u;
    expect(String(line?.content)).not.toMatch(C);
    expect(String(line?.matched)).not.toMatch(C);
    // The raw day log, not just the parsed view: the whole point is bytes on disk.
    const raw = readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8")
      .split("\n")
      .filter((l) => l.includes("auto_capture_restatable"))
      .join("\n");
    expect(raw).not.toMatch(C);
    expect(raw).toContain("Ship with `npm run deploy`.");
    // The matcher accepts the candidate, so the refusal is written and no row.
    expect((await rowsWith("av-ctl")).length).toBe(0);
  });

  // ──  P0: the scan is lazy and visible ──────────────────────────────────

  test("a pass with no candidates reads no tree", async () => {
    // The build is a synchronous `git ls-files` plus a read of every tracked
    // text file — 108 ms for 218 files in this repo — and the old code paid it
    // before looking at the candidate list, so an empty answer still scanned
    // everything.
    await capture(makeRepo("lazy"), [], "ses-lazy");
    expect(
      readEvidenceLog().some(
        (l) => l.ev === "auto_capture_scan" && String(l.session) === "ses-lazy",
      ),
    ).toBe(false);
  });

  test("a pass that checks names what it read", async () => {
    // `scanned()` shipped "for evidence" and was never called, so the tree read
    // had no record at all. One line per pass that built the index.
    await capture(
      makeRepo("scan-line"),
      [{ type: "learning", scope: "av-scan", content: README_TEXT }],
      "ses-scan",
    );
    const scan = readEvidenceLog().find(
      (l) => l.ev === "auto_capture_scan" && String(l.session) === "ses-scan",
    );
    expect(scan).toBeDefined();
    expect(Number(scan?.candidates)).toBe(1);
    expect(Number(scan?.files)).toBe(2);
    expect(Number(scan?.bytes)).toBeGreaterThan(0);
    expect(String(scan?.tracked)).toBe("true");
    expect(Number(scan?.restatements)).toBe(1);
    expect(Number(scan?.verdicts)).toBe(1);
  });

  test("a restatable candidate is refused before the gate runs", async () => {
    // The availability refusal runs BEFORE the write gate, so a restatable
    // candidate never becomes a gate contender: here a credential-shaped
    // scope is refused as a restatement, and the gate — which would have
    // blocked it too — never sees it. The refusal line is the whole record.
    const sid = await capture(
      makeRepo("blocked-verdict"),
      [
        {
          type: "learning",
          scope: "api_key=sk-abcdefghij1234567890",
          content: README_TEXT,
        },
      ],
      "ses-blocked-verdict",
    );
    const ev = readEvidenceLog();
    const scan = ev.find(
      (l) => l.ev === "auto_capture_scan" && String(l.session) === sid,
    );
    // The refusal really fired, and the row really did not land: without
    // both, the assertions below would pass on a pass that did nothing.
    expect(
      ev.some(
        (l) =>
          l.ev === "auto_capture_restatable" &&
          String(l.session) === sid &&
          String(l.reason) === "in_tracked_file",
      ),
    ).toBe(true);
    expect(
      ev.some(
        (l) => l.ev === "auto_capture_blocked" && String(l.session) === sid,
      ),
    ).toBe(false);
    expect(
      (await loadAll()).some((m) => String(m.scope).includes("api_key")),
    ).toBe(false);
    // No capture path writes the demotion tag any more: refusal replaced it.
    expect(
      (await loadAll()).some((m) => m.tags?.includes(RESTATABLE_TAG)),
    ).toBe(false);
    expect(Number(scan?.verdicts)).toBe(1);
    expect(Number(scan?.restatements)).toBe(1);
  });

  test("a warning that QUOTES a claim is not a restatement of it", async () => {
    // Review 4568409650. Narrowing the polarity comparison to the cue list fixed
    // `Do not assume X.` but re-opened a family the cue list does not carry:
    //   Stop assuming the cache supports TTL expiration.
    //   Drop the assumption that the parser keeps comments.
    // Both contain the affirmative sentence they warn against, and neither
    // `stop` nor `drop` is a negation cue — nor does `polaritySigns` see it, so
    // the broader predicate an earlier round tried would not have caught this
    // either. The veto reads the words between the sentence start and the hit.
    const repo = join(fixture.root, "warned");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "README.md"),
      "Stop assuming the cache supports TTL expiration.\n\n" +
        "Drop the assumption that the parser keeps comments.\n\n" +
        "The queue drains at zero.\n",
    );
    git(repo, "init", "-q");
    git(repo, "add", ".");
    await capture(repo, [
      {
        type: "learning",
        scope: "warn1",
        content: "The cache supports TTL expiration.",
      },
      {
        type: "learning",
        scope: "warn2",
        content: "The parser keeps comments.",
      },
      // Control in the same repo: the veto must not simply switch the check off.
      {
        type: "learning",
        scope: "warn3",
        content: "The queue drains at zero.",
      },
    ]);
    expect(refusalFor("warn1")).toHaveLength(0);
    expect(refusalFor("warn2")).toHaveLength(0);
    expect(refusalFor("warn3").length).toBe(1);
    // The two warnings are kept — quoting a claim is not restating it — and
    // the plain restatement is the only candidate refused.
    for (const scope of ["warn1", "warn2"])
      expect((await rowsWith(scope)).length).toBe(1);
    expect((await rowsWith("warn3")).length).toBe(0);
  });

  test("the logged span cannot carry a credential the content redacted", async () => {
    // `norm()` lowercases before the refusal's `matched` span
    // is cut, and the prefix scrubber matches `AKIA[A-Z0-9]{16}` CASE-SENSITIVELY,
    // so a span normalised before scrubbing keeps a recoverable key: the line
    // would say `akia1234567890abcdef` where the candidate said the uppercase
    // form. Redacting the span later cannot undo normalisation, so the scrub
    // happens on the raw text.
    const SECRET = "AKIA1234567890ABCDEF";
    const repo = join(fixture.root, "span-secret");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "README.md"),
      `The staging access key is ${SECRET} for the integration account.\n`,
    );
    git(repo, "init", "-q");
    git(repo, "add", ".");
    const sid = await capture(repo, [
      {
        type: "learning",
        scope: "creds",
        content: `The staging access key is ${SECRET} for the integration account.`,
      },
    ]);
    const refused = refusalFor("creds");
    // The case only means something if the refusal fired and a span was logged.
    expect(refused.length).toBe(1);
    expect(String(refused[0].matched)).toContain("[redacted]");
    // Every field of the RAW line, not just the one under test: normalisation
    // has more than one way to hide a secret from a case-sensitive scrubber.
    const raw = readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8")
      .split("\n")
      .filter((l) => l.includes(`session=${sid}`) && l.includes("creds"));
    expect(raw.length).toBeGreaterThan(0);
    for (const line of raw) {
      expect(line.toLowerCase()).not.toContain("akia1234567890abcdef");
      expect(line).not.toContain(SECRET);
    }
    // The candidate restates the tree, so nothing reaches the store: the
    // refusal line is the only place this text survives, scrubbed or not.
    expect((await rowsWith("creds")).length).toBe(0);
  });
});
