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
  candidate: string;
  expectTag: boolean;
  source: string;
}

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
  {
    id: "new-number-on-declared-command",
    tree: "# release\n\nThe deploy script runs rsync.\n",
    candidate: "The deploy script retries 3 times before it alerts.",
    expectTag: false,
    source:
      "#402 veto 2 — a changed figure is a different fact, not a rephrasing",
  },
  {
    id: "restriction-on-declared-command",
    tree: "# release\n\n`npm run deploy` runs rsync against the box.\n",
    candidate:
      "Never run `npm run deploy` until finance confirms approval code BLUEBIRD.",
    expectTag: false,
    source: "#397 round 3 — the restriction and the code appear nowhere",
  },
  {
    id: "short-restriction-on-declared-command",
    tree: "# release\n\n`npm run deploy` runs rsync against the box.\n",
    candidate: "`npm run deploy` wipes the staging database.",
    expectTag: false,
    source: "#397 round 2 — a short residual is not a restatement",
  },
  {
    id: "second-command-not-swallowed",
    tree: "# release\n\n`npm run deploy` runs rsync against the box.\n",
    candidate:
      "Before `npm run deploy`, run `aws sso login --profile prod` to refresh credentials.",
    expectTag: false,
    source:
      "#397 round 4 — every command span was stripped after ONE declared gate",
  },
  {
    id: "prohibition-on-declared-command",
    tree: "# release\n\n`npm run deploy` runs rsync against the box.\n",
    candidate: "Never run `npm run deploy` on a Friday.",
    expectTag: false,
    source: "#397 — a sentence that states a command may also forbid it",
  },

  // ── Declared gate: where it does and does not reach ───────────────────────
  {
    id: "declared-command-restated",
    tree: "# release\n\n`npm run deploy` runs rsync against the box.\n",
    candidate: "npm run deploy runs rsync against the box.",
    expectTag: true,
    source: "#389 — the declared-gate rule's true positive, backticks aside",
  },
  {
    id: "declared-command-reworded-residual",
    tree: "# release\n\n`npm run deploy` runs rsync against the box.\n",
    candidate: "Run `npm run deploy` to rsync against the box.",
    expectTag: false,
    source:
      "#397 round 4 — the residual is checked too, and a reworded residual is kept",
  },
  {
    id: "declared-command-new-context",
    tree: "# release\n\n`npm run deploy` runs rsync against the box.\n",
    candidate: "Use `npm run deploy` when the build is ready.",
    expectTag: false,
    source:
      "#397 round 2 — the manifest states the command, not when to use it",
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
