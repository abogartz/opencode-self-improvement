// Availability case bank (issue #402, phase P4).
//
// Every adversarial case this matcher has been found guilty of, in one file, with
// the tree text that exposes it. The unit tests in `test/capture-available.test.ts`
// drive the same behaviour through the plugin; this bank exists so the BENCH can
// answer a question the unit tests cannot: what does the shipped check decide over
// a population, and did that population's verdicts move since the last run? A
// single flipped verdict changes the tag rate, the demotion, and every recall
// number in `availability-results.md`, and until now none of those moved together
// in a way a reader could point at.
//
// One repo per case. Sharing one tree would let a candidate match a DIFFERENT
// case's line and report a verdict for the wrong reason — the exact class of defect
// this file exists to keep out.
//
// `expectTag` is what the shipped `availabilityIndex` must decide, not what any
// historical rule decided. `source` names the review round that found it, so a
// regression says who to blame.
export interface AvailabilityCase {
  id: string;
  /** Tracked README content. Each sentence ends in a period: `norm()` collapses
   * newlines, so an unterminated bullet borrows its neighbour's negation. */
  tree: string;
  /** Extra tracked files, path to content. A case whose name says "declared"
   * MUST declare the command here: `parseGates` reads `package.json`, `Makefile`,
   * `makefile`, `justfile` and `.github/workflows/*.yml`, and nothing else. Put
   * the command in the README instead and the TEXT branch answers for it, which
   * is exactly how seven gate cases passed while the gate went untested. */
  files?: Record<string, string>;
  candidate: string;
  expectTag: boolean;
  /** Asserted when set. Tag-or-keep alone cannot say WHICH branch fired, and that
   * is the difference between a gate test and a prose test wearing its name. */
  expectReason?: "in_tracked_file" | "declared_gate";
  source: string;
}

/** A command declaration `parseGates` really reads. Shared by the gate family so
 * every one of those cases tests the same declaration. */
const DEPLOY_MANIFEST: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "widget",
    scripts: { deploy: "rsync -az ./dist/ deploy@box:/srv" },
  }),
};

/** A README that says nothing about deploying. Without it a `declared_gate`
 * expectation could be satisfied by the prose branch and the reason assertion
 * would be the only thing telling the two apart — which is the defect this
 * revision exists to close, so the README is neutralised as well as declared. */
const NEUTRAL_README =
  "# release\n\nNothing in this file describes deploying.\n";

export const AVAILABILITY_CASES: AvailabilityCase[] = [
  // ── The transport case: the reason the check must not over-refuse ──────────
  {
    id: "nowhere-in-tree",
    tree: "# widget\n\nReorder is inclusive: needsReorder returns true at or below reorderPoint.\n",
    candidate:
      "The staging rate limit is 120 requests per minute per key and it resets on the hour.",
    expectTag: false,
    source:
      "#389 — a fact the tree does not state is the one the store exists for",
  },
  {
    id: "verbatim-restatement",
    tree: "# widget\n\nReorder is inclusive: needsReorder returns true at or below reorderPoint.\n",
    candidate:
      "Reorder is inclusive: needsReorder returns true at or below reorderPoint.",
    expectTag: true,
    source: "#389 — the rule's only true positive",
  },
  {
    id: "formatting-is-not-a-new-fact",
    tree: "# widget\n\nRun `bun test` before every merge.\n",
    candidate: "Run bun test before every merge.",
    expectTag: true,
    source: "#397 — case, backticks and wrapping are formatting",
  },

  // ── Reversal: a substring of the OPPOSITE rule ─────────────────────────────
  {
    id: "negation-dropped",
    tree: "# style\n\nWe do not use tabs for indentation.\n",
    candidate: "Use tabs for indentation.",
    expectTag: false,
    source:
      "#397 round 3 (WhollyMindless) — the worst failure this check can have",
  },
  {
    id: "negation-kept",
    tree: "# style\n\nWe do not use tabs for indentation.\n",
    candidate: "We do not use tabs for indentation.",
    expectTag: true,
    source: "#397 round 3 — the guard did not simply switch the check off",
  },
  {
    id: "word-boundary",
    tree: "# style\n\nDo not abuse tabs for indentation.\n",
    candidate: "Use tabs for indentation.",
    expectTag: false,
    source: "#397 round 3 — `use tabs` is not a hit inside `abuse tabs`",
  },

  // ── A warning that QUOTES a claim: no polarity test of any breadth sees it ──
  {
    id: "stop-assuming",
    tree: "# cache\n\nStop assuming the cache supports TTL expiration.\n",
    candidate: "The cache supports TTL expiration.",
    expectTag: false,
    source:
      "#403 review (4568409650) — reopened by narrowing the polarity equality",
  },
  {
    id: "drop-the-assumption",
    tree: "# parser\n\nDrop the assumption that the parser keeps comments.\n",
    candidate: "The parser keeps comments.",
    expectTag: false,
    source: "#403 review (4568409650) — second shape, same family",
  },
  {
    id: "never-assume",
    tree: "# queue\n\nNever assume the queue preserves order.\n",
    candidate: "The queue preserves order.",
    expectTag: false,
    source: "#403 review — the cue-list path of the same family",
  },
  {
    id: "deterrent-verb-not-governing",
    tree: "# job\n\nThe job stops at midnight and the cache supports TTL expiration.\n",
    candidate: "The cache supports TTL expiration.",
    expectTag: true,
    source:
      "#403 self-review — the veto's own over-decline, caught by this case",
  },
  {
    id: "ordinary-verb-not-a-deterrent",
    tree: "# parser\n\nThe parser drops stale entries after a write.\n",
    candidate: "The parser drops stale entries after a write.",
    expectTag: true,
    source:
      "#403 self-review — `drops` governs `stale entries`, not a following claim",
  },

  // ── New information riding a restated fragment ────────────────────────────
  {
    id: "new-clause-rides-restatement",
    tree: "# rate\n\nThe staging rate limit is documented in config/limits.ts.\n",
    candidate:
      "The staging rate limit is documented in config/limits.ts; Finance confirmed the supplier rate is 1900.",
    expectTag: false,
    source:
      "#397 review — matching PART of a candidate does not establish the WHOLE fact",
  },
  // ── Declared gate: where it does and does not reach ───────────────────────
  // Review round 4 (WhollyMindless) found that every case below declared its
  // command in README prose, so the TEXT branch decided all of them and a
  // mutation replacing `gateHit(spans, gates)` with a null gate left the entire
  // bank green. They now declare `scripts.deploy` in a real `package.json` and
  // run against a README that cannot match, with `expectReason` pinning which
  // branch answered.
  {
    id: "declared-command-restated",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Run `npm run deploy`.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "#389 — the gate rule's true positive; #403 review 4 moved it onto a real declaration",
  },
  {
    id: "make-target-restated",
    tree: NEUTRAL_README,
    files: { Makefile: "test:\n\tbun test\n" },
    candidate: "Run `make test`.",
    expectTag: true,
    expectReason: "declared_gate",
    source:
      "#403 review 4 — a second gate source, so the bank does not silently depend on package.json alone",
  },
  {
    id: "make-target-new-condition",
    tree: NEUTRAL_README,
    files: { Makefile: "test:\\n\\tbun test\\n" },
    candidate: "Run `make test` before merging.",
    expectTag: false,
    source:
      "#403 review 4 — the counterpart, and the case that was wrong when written: the target is declared, the WHEN is not",
  },
  {
    id: "declared-command-reworded-residual",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Run `npm run deploy` to rsync against the box.",
    expectTag: false,
    source:
      "#397 round 4 — the residual is checked too, and a reworded residual is kept",
  },
  {
    id: "declared-command-new-context",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Use `npm run deploy` when the build is ready.",
    expectTag: false,
    source:
      "#397 round 2 — the manifest states the command, not when to use it",
  },
  {
    id: "prohibition-on-declared-command",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Never run `npm run deploy` on a Friday.",
    expectTag: false,
    source: "#397 — a sentence that states a command may also forbid it",
  },
  {
    id: "restriction-on-declared-command",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate:
      "Never run `npm run deploy` until finance confirms approval code BLUEBIRD.",
    expectTag: false,
    source: "#397 round 3 — the restriction and the code appear nowhere",
  },
  {
    id: "short-restriction-on-declared-command",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "`npm run deploy` wipes the staging database.",
    expectTag: false,
    source: "#397 round 2 — a short residual is not a restatement",
  },
  {
    id: "second-command-not-swallowed",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate:
      "Before `npm run deploy`, run `aws sso login --profile prod` to refresh credentials.",
    expectTag: false,
    source: "#397 round 2 — the second command is new information",
  },
  {
    id: "new-number-on-declared-command",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Run `npm run deploy`; it retries 3 times before it alerts.",
    expectTag: false,
    source:
      "#402 veto 2 — a changed figure is a different fact, not a rephrasing",
  },
  {
    id: "prose-command-not-a-code-span",
    tree: NEUTRAL_README,
    files: DEPLOY_MANIFEST,
    candidate: "Deploy with npm run deploy; it copies the build to the box.",
    expectTag: false,
    source:
      "self-review of the case bank — `statedCommands` reads code spans only, so a prose command never reaches the gate; recorded as a limit, not fixed",
  },
  {
    id: "prose-restatement-still-tags",
    tree: "# limits\n\nThe rate limiter keeps state in Redis DB 3, not DB 0 like the rest of the stack.\n",
    // The asymmetry with `prose-command-not-a-code-span` is deliberate: the text
    // side compares claims, so prose restatement is caught even though a prose
    // command is not. Paired, they say which half of the check the formatting
    // dependency belongs to; either alone says nothing.
    candidate:
      "The rate limiter keeps state in Redis DB 3, not DB 0 like the rest of the stack.",
    expectTag: true,
    expectReason: "in_tracked_file",
    source:
      "self-review of the case bank — the counterpart to the prose-command limit above",
  },

  // ── The gate's own vocabulary must not tag ordinary prose ─────────────────
  {
    id: "gate-name-in-prose",
    tree: "# ci\n\nThe deploy gate is documented in runbook.md.\n",
    candidate: "The deploy gate name is a short string used by the dashboard.",
    expectTag: false,
    source:
      "#397 review — a short gate name does not tag prose that merely contains it",
  },
];
