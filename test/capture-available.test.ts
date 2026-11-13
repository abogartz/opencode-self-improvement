// Contract (#389, changed by #402): capture flags what the next session can read
// in the working tree, and STORES IT ANYWAY.
//
// The discriminator still comes from measurement, not taste (FINDINGS
// 2026-11-10): reuse pays nothing (six pairs, median L2/L0 0.98x) while transport
// pays everything (empty store 0/5, seeded 5/5). What separates the two is
// whether the next session could get the fact by itself.
//
// What #402 changed is the CONSEQUENCE, not the check. The first version dropped
// a candidate the moment it matched. Measured against this repo's live store it
// refused 30 of 1166 real captured rows and 29 of those were wrong — "OpenCode V2
// (v2.0.26) does NOT run LSP servers" was refused because the row contained the
// string `bun test` and the project declares a `test` script. Four review rounds
// on #397 hardened the matcher until it refuses 0 of 1166, which is the other
// half of the same evidence: no lexical rule is defensible as a delete.
//
// So every test below asserts the same invariant FIRST — the row reaches the
// store — and the tag is what differs between cases. A wrong verdict now costs
// one row; a right one saves an injection slot. That is the property four rounds
// of patches could not produce, because each round patched one matcher instance
// while the failure mode stayed "silently lose a fact".
//
// Fail-open is still the contract on every uncertainty. A missing git, a non-repo
// workspace, or an unreadable file is not evidence that a fact is available, and
// acting on those would spend the one measured benefit capture has.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetCaptureCooldowns, resetSessionModels } from "../src/index.ts";
import { RESTATABLE_TAG } from "../src/core/tags.ts";
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

describe("capture availability tag (#389, #402)", () => {
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | undefined;

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
    await waitFor(() =>
      readEvidenceLog().some((l) => String(l.session) === sid),
    );
    // Let every candidate's receipt land, not just the first.
    await new Promise((r) => setTimeout(r, 250));
    return sid;
  }

  const evidence = () => readEvidenceLog();
  const rowsWith = async (scope: string) =>
    (await loadAll()).filter((m) => m.scope === scope);
  /** The audit line for one scope, once the row has been tagged. */
  const tagFor = (scope: string) =>
    evidence().filter(
      (l) => l.ev === "auto_capture_restatable" && String(l.scope) === scope,
    );

  // ── The invariant every case below is written against ──────────────────────

  test("the availability check cannot prevent a write — all-restatable batch", async () => {
    // #402 in one assertion. Before it, three candidates like these produced zero
    // rows and no trace of what was lost.
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
        content: "Reorder is inclusive: needsReorder returns true.",
      },
    ]);
    for (const scope of ["av-inv1", "av-inv2", "av-inv3"])
      expect((await rowsWith(scope)).length).toBe(1);
  });

  // ── The two provable forms, now tags ───────────────────────────────────────

  test("a candidate that restates a tracked file is tagged, with the file named", async () => {
    await capture(makeRepo("restated"), [
      {
        type: "learning",
        scope: "av-restated",
        content: README_TEXT,
      },
    ]);
    const tagged = tagFor("av-restated");
    expect(tagged.length).toBe(1);
    expect(String(tagged[0].reason)).toBe("in_tracked_file");
    expect(String(tagged[0].where)).toBe("README.md");
    // The row is stored, and carries the tag the matcher earned.
    const rows = await rowsWith("av-restated");
    expect(rows.length).toBe(1);
    expect(rows[0]?.tags ?? []).toContain(RESTATABLE_TAG);
    // The audit line carries the whole candidate, so it alone can rebuild the row.
    expect(String(tagged[0].content)).toContain("needsReorder");
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
    expect(tagFor("av-near").length).toBe(1);
    expect(String(tagFor("av-near")[0].reason)).toBe("in_tracked_file");
    expect((await rowsWith("av-near")).length).toBe(1);
  });

  test("a command the project declares is tagged, with the gate named", async () => {
    // The bare mention is the case the manifest can actually answer. Prose
    // riding the command is a claim the manifest does not make, so it is left
    // untagged (#397 round 3); see the gate-claim test below.
    await capture(makeRepo("gate"), [
      {
        type: "pattern",
        scope: "release",
        content: "Ship with `npm run deploy`.",
      },
    ]);
    const tagged = tagFor("release");
    expect(tagged.length).toBe(1);
    expect(String(tagged[0].reason)).toBe("declared_gate");
    expect(String(tagged[0].where)).toContain("package.json scripts.deploy");
    const rows = await rowsWith("release");
    expect(rows.length).toBe(1);
    expect(rows[0]?.tags ?? []).toContain(RESTATABLE_TAG);
  });

  // ── What the matcher must NOT claim ────────────────────────────────────────

  test("a restriction ON a declared command is new information — untagged", async () => {
    // Review #397 (WhollyMindless): merely finding a declared command does not
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
    expect(tagFor("release2")).toHaveLength(0);
    const rows = await rowsWith("release2");
    expect(rows.length).toBe(1);
    expect(rows[0]?.tags ?? []).not.toContain(RESTATABLE_TAG);
  });

  test("a restated clause carrying a new clause is untagged", async () => {
    // Review #397: one old clause matching must not tag the whole row and hide
    // the unavailable fact riding it.
    await capture(makeRepo("mixed"), [
      {
        type: "learning",
        scope: "mixed",
        content: `${README_TEXT} Finance confirmed the external supplier rate is 1900 basis points.`,
      },
    ]);
    expect(tagFor("mixed")).toHaveLength(0);
    expect((await rowsWith("mixed")).length).toBe(1);
  });

  test("a SHORT restriction on a declared command is untagged (#397 round 2)", async () => {
    // Review #397 (WhollyMindless): the residual after the command span is
    // stripped is 27 characters, and the whole fact is in it. The manifest
    // declares that `deploy` exists; it declares nothing about approval.
    await capture(makeRepo("gate-short"), [
      {
        type: "blocker",
        scope: "release4",
        content: "Never run `npm run deploy` without approval.",
      },
    ]);
    expect(tagFor("release4")).toHaveLength(0);
    expect((await rowsWith("release4")).length).toBe(1);
  });

  test("a restated clause carrying a SHORT new clause is untagged (#397 round 2)", async () => {
    // Review #397 (WhollyMindless): the new clause is below the MIN_CLAUSE
    // threshold this file used to split on, so the old code dropped it from
    // `needed` and refused on the old clause alone.
    // A short clause can carry the entire new number.
    await capture(makeRepo("mixed-short"), [
      {
        type: "learning",
        scope: "mixed2",
        content: `${README_TEXT}; External rate is 1900.`,
      },
    ]);
    expect(tagFor("mixed2")).toHaveLength(0);
    expect((await rowsWith("mixed2")).length).toBe(1);
  });

  test("a declared command does not swallow a new behavioural fact (#397 round 3)", async () => {
    // Review #397 (WhollyMindless): the residual left by the command strip was
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
    expect(tagFor("release5")).toHaveLength(0);
    expect(tagFor("release6")).toHaveLength(0);
    expect((await rowsWith("release5")).length).toBe(1);
    expect((await rowsWith("release6")).length).toBe(1);
  });

  test("nothing is discarded before the tag is decided (#397 round 4)", async () => {
    // Review #397 (WhollyMindless), two gaps on `fe00c92`:
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
    expect(tagFor("release7")).toHaveLength(0);
    expect(tagFor("release8")).toHaveLength(0);
    expect(tagFor("mixed3")).toHaveLength(0);
    expect((await rowsWith("release7")).length).toBe(1);
    expect((await rowsWith("release8")).length).toBe(1);
    expect((await rowsWith("mixed3")).length).toBe(1);
  });

  test("a substring of the OPPOSITE rule is not a restatement (#397 round 3)", async () => {
    // Review #397 (WhollyMindless): the clause lookup matched `Use tabs for
    // indentation.` INSIDE `We do not use tabs for indentation.`. That is the
    // worst failure this check can have: it hides the correction and leaves the
    // doc's authority behind the reversed rule. A match now has to sit in a
    // sentence of the same polarity — and the verbatim negated rule is still
    // tagged, so the guard did not simply switch the check off.
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
    // Scoped, not global: other cases in this file tag rows too.
    expect(tagFor("style")).toHaveLength(0);
    const tagged = tagFor("style2");
    expect(tagged.length).toBe(1);
    expect(String(tagged[0].reason)).toBe("in_tracked_file");
    // Both rows exist. Before #402 the first one did not.
    const style = await rowsWith("style");
    expect(style.length).toBe(1);
    expect(style[0]?.tags ?? []).not.toContain(RESTATABLE_TAG);
    expect((await rowsWith("style2")).length).toBe(1);
  });

  test("a figure the declaration does not carry is a different fact (#402 veto 2)", async () => {
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
    expect(tagFor("release9")).toHaveLength(0);
    expect((await rowsWith("release9")).length).toBe(1);
  });

  // ── Fail-open: no evidence means no tag ────────────────────────────────────

  test("a fact that is nowhere in the tree is untagged — this is the transport case", async () => {
    await capture(makeRepo("transport"), [
      {
        type: "learning",
        scope: "av-staging",
        content:
          "The staging API rate limit is 120 requests per minute per key; importers must pace at 2/s or they get 429s.",
      },
    ]);
    expect(tagFor("av-staging")).toHaveLength(0);
    expect((await rowsWith("av-staging")).length).toBe(1);
  });

  test("a workspace that is not a git repo tags nothing: no git is no evidence", async () => {
    await capture(makeRepo("plain", false), [
      { type: "learning", scope: "av-plain", content: README_TEXT },
    ]);
    expect(tagFor("av-plain")).toHaveLength(0);
    expect((await rowsWith("av-plain")).length).toBe(1);
  });

  test("a short gate name does not tag prose that merely contains it", async () => {
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
    expect(tagFor("setup")).toHaveLength(0);
    expect((await rowsWith("setup")).length).toBe(1);
  });

  // ── Monotonicity and cost ──────────────────────────────────────────────────

  test("tagging a restatement never deletes a row the store already kept", async () => {
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
        scope: "av-mono",
        content: "The kept row: reorder uses a strict less-than compare.",
        status: "settled",
      }) + "\n",
    );
    await capture(repo, [
      { type: "learning", scope: "av-mono", content: README_TEXT },
    ]);
    expect(tagFor("av-mono")).toHaveLength(1);
    // Both rows: the pre-existing one AND the tagged new one. A tag is additive;
    // consolidation is the only thing that retires a row, and it needs proven
    // reads (`consolidate/propose.ts`), which availability does not have.
    const kept = await rowsWith("av-mono");
    expect(kept.length).toBe(2);
    expect(kept.some((m) => m.content.includes("The kept row"))).toBe(true);
    expect(kept.some((m) => m.tags?.includes(RESTATABLE_TAG))).toBe(true);
    // A tag writes no supersession and no blocklist entry.
    expect(
      evidence().some((l) => String(l.ev ?? "").includes("supersede")),
    ).toBe(false);
  });

  test("the tag lowers injected bytes, not the model call: #389 AC4 cannot hold", async () => {
    // Criterion 4 of #389 expected capture's token cost to fall. It cannot.
    // Candidates come FROM the model, so availability can only be evaluated
    // after the call that produced them. #402 makes the position honest rather
    // than arguing it: the check now changes which rows give up injection
    // budget, never how many tokens the pass spent, and never how many rows
    // exist. Pinned, so a future cost claim about this mechanism has to move a
    // test instead of re-deriving the assumption.
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
    // Two of three tagged as restatable, and ALL THREE stored.
    expect(
      readEvidenceLog().filter((l) => l.ev === "auto_capture_restatable")
        .length,
    ).toBe(2);
    for (const scope of ["av-cost-inv", "av-cost-rel", "av-cost-stg"])
      expect((await rowsWith(scope)).length).toBe(1);
  });

  test("a guided row that contradicts the tree is not tagged as restatable", async () => {
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
    expect(tagFor("av-contra")).toHaveLength(0);
    const rows = await rowsWith("av-contra");
    expect(rows.length).toBe(1);
    expect(rows[0]?.tags ?? []).not.toContain(RESTATABLE_TAG);
  });

  // ── #402 P0: the scan is lazy and visible ──────────────────────────────────

  test("a pass with no candidates reads no tree (#402 P0)", async () => {
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

  test("a pass that checks names what it read (#402 P0)", async () => {
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
    expect(Number(scan?.files)).toBe(2);
    expect(Number(scan?.bytes)).toBeGreaterThan(0);
    expect(String(scan?.tracked)).toBe("true");
    expect(Number(scan?.restatements)).toBe(1);
    expect(Number(scan?.verdicts)).toBe(1);
  });

  test("a verdict on a row the gate refuses is a verdict, not a tag (#403 review)", async () => {
    // The availability check runs BEFORE the write gate, so a candidate can earn
    // a verdict and then be refused — here for a credential-shaped scope. The
    // first version counted the verdict, so the scan line read `restatements=1`
    // for a store with no tagged row at all. Two fields now, and only the second
    // one is a fact about the store.
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
    // The verdict really fired, and the row really did not land: without both,
    // the assertion below would pass on a pass that did nothing.
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
        (l) =>
          l.ev === "auto_capture_blocked" &&
          String(l.session) === sid &&
          String(l.reason) === "credential_in_metadata",
      ),
    ).toBe(true);
    expect(
      (await loadAll()).some((m) => m.tags?.includes(RESTATABLE_TAG)),
    ).toBe(false);
    expect(Number(scan?.verdicts)).toBe(1);
    expect(Number(scan?.restatements)).toBe(0);
  });
});
