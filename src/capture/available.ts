// #389: capture spends its budget on facts the next session cannot obtain any
// other way.
//
// Measured (FINDINGS 2026-11-10, base3 vs base4): reuse does not pay — six pairs,
// every arm 6/6, median L2/L0 0.98x — while transport does: an empty store 0/5,
// the same store seeded 5/5. The difference is not "interesting" and not
// "durable". It is whether the next session could get the fact by itself. Capture
// had no notion of that question, and at roughly a third of a session's own
// generation a row that changes nothing is not free.
//
// Two availability questions are answerable by a CODE PATH, with no prompt and no
// model call, which is what #389 criterion 1 demands:
//
//   1. Is this text already in the working tree? A row that restates a tracked
//      file is readable there by the next session.
//   2. Is this command already declared by the project's own gates? A row that
//      says "run `make deploy`" is answered by the Makefile.
//
// Both produce a TAG, not a refusal (#402). Four adversarial review rounds on
// #397 each found the same defect — text that was merely short or partly matched
// was read as already known — and each round patched one instance. Measured
// against this repo's live store: the original rule refused 30 of 1166 real
// captured rows and 29 of those were wrong (the note "OpenCode V2 (v2.0.26) does
// NOT run LSP servers" was refused because it contained the string `bun test` and
// this project declares a `test` script). The hardened rule refuses 0 of 1166. A
// check nobody can trust enough to delete with, and nobody can make cheap enough
// to skip, must not decide anything on its own.
//
// So the verdict is now evidence attached to a row that is stored anyway:
//
//   - it cannot drop a row, so a wrong match costs a tag instead of a fact;
//   - every claim is checked, not sampled: one unchecked clause is enough to make
//     the row new, and the unchecked part is where the new fact lives;
//   - polarity and numbers are VETOES, not evidence: they can only decline to
//     tag, never create one. The number check is the house `numericTokens` set
//     from `core/tokenize.ts`; see the two vetoes below for why the polarity
//     check keeps its own cue list as well.
//
// The vetoes can only REMOVE a tag, never add one — which holds only because the
// one place that compares two texts, `findClause`, compares them on the narrow
// cue list. Widen that comparison and agreement gets easier, and an agreement is
// what creates a tag; see VETO 1. Saltzer & Schroeder's fail-safe principle,
// applied to a suppression filter: the default is keep, and a bug must surface as
// a visible duplicate rather than as content that is gone.
//
// A wrong tag is not free either. The row survives, but `fitOrder` gives it up
// first when the injection budget binds, so a false positive costs the row its
// slot for the queries that needed it. That is the real price of a bad verdict,
// and it is why the matcher is still held to the veto-only shape.
//
// Storing instead of deleting has a second consequence, and it is not a tag
// effect. A stored row is a live GATE-3 contender, so a later write at >=0.9
// overlap is now refused `superseded_overlap` where the delete policy would have
// let it promote. Measured: an ordinary-tagged seed blocks the same write with
// the same reason, so the tag changes nothing in the gate — the row being there
// does. That is the gate working as designed on a genuine near-duplicate, with a
// hint naming the row to `memory_update`, and it is the cost of no longer
// destroying facts. P5 decides whether the check earns its keep at all.
//
// Fail-open is the rule throughout. A missing git, an unreadable file, a repo
// that is not a repo, or a budget that ran out is NOT evidence that a fact is
// available — refusing on those would lose the transport win, which is the one
// measured benefit capture has. Every uncertainty keeps the candidate.
import { lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { POL_NEG, numericTokens, polaritySigns } from "../core/tokenize.ts";
import { redactSecrets } from "../store/secrets.ts";

/** What made a candidate restatable, and where the next session can get it. */
export type AvailabilityVerdict = {
  reason: "in_tracked_file" | "declared_gate";
  /** Repo-relative file, or the gate's location (`package.json scripts.test`). */
  where: string;
  /** The span that matched, for the evidence line. */
  matched: string;
};

// Tokens that carry no claim of their own: function words, and the handful of
// verbs whose whole meaning is "this command gets run". A fragment made of
// nothing but these is a MENTION, and a mention is what the manifest already
// declares. Everything else is a claim, however short it is — `never` is five
// characters and it is the entire fact (#397 round 4, WhollyMindless: the length
// cutoff dropped `Never` and refused the prohibition).
//
// This is a whitelist for FILLER, which is the only direction a word list can
// safely go: a word left off it is read as a claim and the row is kept. The
// RESTRICTION list this replaces whitelisted what counted as NEW, so every word
// missing from it lost a fact — that is the defect round 3 reported.
//
// Temporal and conditional words (before, after, until, unless, when, if, only,
// once) and every modal are deliberately absent: they state a condition, and a
// manifest declares THAT a command exists, never when it may be run.
const FILLER = new Set([
  // function words
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "and",
  "or",
  "but",
  "so",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "as",
  "than",
  "it",
  "its",
  "us",
  "we",
  "our",
  "you",
  "your",
  "they",
  "their",
  "them",
  "he",
  "she",
  "i",
  "me",
  "my",
  "is",
  "are",
  "am",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  // mention verbs: "ship with X", "run X", "use X" say only that X is there
  "run",
  "runs",
  "running",
  "use",
  "uses",
  "using",
  "ship",
  "ships",
  "shipping",
  "deploy",
  "deploys",
  "deploying",
  "call",
  "calls",
  "calling",
  "invoke",
  "invokes",
  "invoking",
  "execute",
  "executes",
  "executing",
]);

// Assertion boundaries: the edges of the one sentence a match is judged inside.
// The candidate is split on these, and the text in the tree is walked back to
// them (#397 round 3). Code 0 is the joiner the scan puts between tracked
// files, so a clause can never match across two of them.
function isBoundary(code: number): boolean {
  return (
    code === 46 || // .
    code === 59 || // ;
    code === 58 || // :
    code === 44 || // ,
    code === 10 || // newline
    code === 0 // the file joiner
  );
}

// Words that reverse an assertion. This is deliberately NOT the RESTRICTION
// list it replaces. That list tried to decide whether a candidate says anything
// NEW, and an open vocabulary can never do that (#397 round 3, WhollyMindless):
// any word left off the list reopens the class. This one answers one closed
// question — does the sentence the tree states have the same POLARITY as the
// clause matched inside it? `We do not use tabs` and `Use tabs` are not the
// same assertion, and a gate that cannot tell them apart stores the reversal of
// the rule it was reading.
const NEGATION =
  /\b(no|not|nor|never|none|cannot|can'?t|don'?t|doesn'?t|didn'?t|won'?t|isn'?t|aren'?t|without|lacks?|lacking|absent|avoid\w*|prohibit\w*|forbid\w*|disallow\w*|refrain\w*|refuses?|instead of|rather than)\b/;

/**
 * VETO 1 (#402): is this sentence reversed?
 *
 * Two sources, unioned, because they answer different questions:
 *
 *   - `NEGATION`, the cue list: "we do NOT use tabs" is negated prose.
 *   - `core/tokenize.ts`'s `polaritySigns`, which is NOT a negation detector and
 *     must not be used as one. It extracts the SIGNED PREDICATES a text asserts
 *     for the contradiction surface, so "we do not use tabs" returns `[]` —
 *     `use` is not a table term. Substituting it for the cue list would have
 *     compared `[]` with `[]`, matched, and re-opened the exact round-3 defect
 *     this regex was written to close. What it adds here is the part a cue list
 *     cannot see: the antonym pairs and the dual-role "never", so "must never
 *     disable" and "enable" do not read as the same claim.
 *
 * USE THIS ONLY WHERE THE ANSWER IS ABSOLUTE. `forbidsCommand` asks "does this
 * sentence forbid the command?" and a yes declines to tag, so widening it can
 * only ever decline — the fail-safe direction.
 *
 * The relative use, where one text's polarity is compared with another's, is
 * `cueNegated`, and the difference is not academic. Equality gets EASIER as both
 * predicates get broader, and in `findClause` an agreement is what CREATES the
 * tag. Measured on the round-3 case: tree `Do not assume the cleaner removes
 * unused rows.`, candidate `The cleaner removes unused rows.` — `polaritySigns`
 * reads the dual-role `removes` as negative in BOTH strings, the union agrees,
 * and the affirmative claim is tagged as restating the sentence that warns
 * against it. The cue list alone sees `not` on one side and nothing on the other
 * and declines. That is the defect this veto exists for, arriving from the
 * opposite direction.
 */
function negated(text: string): boolean {
  return NEGATION.test(text) || polaritySigns(text).includes(POL_NEG);
}

/**
 * Cue-list polarity, for the one place that COMPARES two texts. Narrow on
 * purpose: a broader predicate here agrees more often, and every extra agreement
 * is a tag.
 */
function cueNegated(text: string): boolean {
  return NEGATION.test(text);
}

/**
 * VETO 2 (#402): a figure the matched declaration does not carry.
 *
 * `core/tokenize.ts` states the rule and `store/tombstones/tombstone.ts`
 * measures it on this repo's own data: a correction scores HIGHER than an honest
 * rewording, so overlap alone cannot separate "the same fact again" from "the
 * fact has changed". On the declared-command path the manifest states only that
 * a command exists, so any number the row asserts has to be in the command
 * itself or the row is new.
 */
function introducesNewNumber(text: string, matched: string): boolean {
  const known = new Set(numericTokens(matched));
  for (const n of numericTokens(text)) if (!known.has(n)) return true;
  return false;
}
// The scan is bounded by bytes, not files: a monorepo's tracked list is huge and
// the point is a cheap check, not an index. One capture pass already pays for a
// model call, which costs far more than this.
const TOTAL_CAP = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LIST_FILES = 20_000;
const LIST_TIMEOUT_MS = 2_000;

// Docs and config carry restated facts far more often than source does, so they
// are read first and are the first to consume the byte budget.
const PRIORITY = [
  ".md",
  ".mdx",
  ".txt",
  ".adoc",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
];
const TEXT_EXTENSIONS = new Set([
  ...PRIORITY,
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".go",
  ".py",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cc",
  ".sh",
  ".bash",
  ".sql",
  ".css",
  ".html",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor"]);

/**
 * Normalise for a "same words, different wrapping" comparison: case, markdown
 * emphasis and backticks, and runs of whitespace. This is verbatim modulo
 * formatting, and the evidence line says so rather than claiming fuzzy matching.
 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function listed(repoDir: string): string[] | null {
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync(["git", "ls-files", "-z"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: LIST_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (p.exitCode !== 0) return null;
  const out = p.stdout?.toString() ?? "";
  if (!out.trim()) return [];
  return out.split("\0").filter(Boolean).slice(0, MAX_LIST_FILES);
}

interface Slice {
  file: string;
  start: number;
  end: number;
}

/** Declared gates: a command the project already runs, and where it is declared. */
interface Gate {
  label: string;
  where: string;
}

function readTracked(repoDir: string, file: string): string | null {
  const p = join(repoDir, file);
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function skipPath(file: string): boolean {
  return file.split("/").some((seg) => SKIP_DIRS.has(seg));
}

function parseGates(repoDir: string, files: string[]): Gate[] {
  const gates: Gate[] = [];
  const add = (label: string, where: string) => {
    const n = norm(label);
    if (n.length >= 2 && n.length <= 80) gates.push({ label: n, where });
  };
  for (const file of files) {
    if (skipPath(file)) continue;
    const base = file.slice(file.lastIndexOf("/") + 1);
    const text =
      base === "package.json" ||
      base === "Makefile" ||
      base === "makefile" ||
      base === "justfile" ||
      /^\.github\/workflows\/.+\.ya?ml$/.test(file)
        ? readTracked(repoDir, file)
        : null;
    if (text === null) continue;
    if (base === "package.json") {
      try {
        const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
        for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
          add(name, `${file} scripts.${name}`);
          if (typeof cmd === "string") add(cmd, `${file} scripts.${name}`);
        }
      } catch {
        // An unparseable manifest is not evidence of absence.
      }
      continue;
    }
    if (base === "Makefile" || base === "makefile" || base === "justfile") {
      for (const line of text.split("\n")) {
        const target = /^([A-Za-z0-9_.%-]+)\s*:(?!=)/.exec(line);
        if (target?.[1]) add(target[1], `${file} target ${target[1]}`);
        const recipe = /^\t+([^\s].*)$/.exec(line);
        if (recipe?.[1]) add(recipe[1], `${file} recipe`);
      }
      continue;
    }
    for (const line of text.split("\n")) {
      const run = /^\s*-?\s*run:\s*["']?(.+?)["']?\s*$/.exec(line);
      if (run?.[1]) add(run[1], `${file} run`);
    }
  }
  return gates;
}

/** Commands a row states: the backticked spans, which is how this plugin writes them. */
function statedCommands(content: string): string[] {
  const spans: string[] = [];
  const re = /`([^`\n]{2,60})`/g;
  let m = re.exec(content);
  while (m) {
    const span = m[1]?.trim();
    if (span && /^[A-Za-z][A-Za-z0-9_.@:/-]*(?:[ =][^\s`]+)*$/.test(span))
      spans.push(span);
    m = re.exec(content);
  }
  return spans;
}

/** Strip the runner so `bun run test` and the script named `test` are the same thing. */
function runners(span: string): string[] {
  const forms = [norm(span)];
  const stripped = norm(span).replace(
    /^(?:bun(?:x| run)?|npm (?:run|exec)|pnpm (?:run|exec)|yarn|make|task)\s+/,
    "",
  );
  if (stripped && stripped !== forms[0]) forms.push(stripped);
  return forms;
}

// Matching is positional, never substring. A gate named `all` must not refuse a
// row that says `install all deps`, and `test` must not refuse a row about
// "the test suite". So a single-word gate (a script name, a make target) only
// matches the OPERAND position — the first token after the runner is stripped —
// and a multi-word gate (a declared command) matches whole.
function gateHit(spans: string[], gates: Gate[]): Gate | null {
  for (const span of spans) {
    for (const form of runners(span)) {
      const first = form.split(" ")[0] ?? "";
      for (const g of gates) {
        if (form === g.label) return g;
        if (!g.label.includes(" ") && first === g.label) return g;
        if (
          g.label.includes(" ") &&
          (form.startsWith(`${g.label} `) || form.endsWith(` ${g.label}`))
        )
          return g;
      }
    }
  }
  return null;
}

/**
 * The assertions in a normalised text: the fragments left after splitting on the
 * sentence boundaries, minus the ones that state nothing.
 *
 * "States nothing" is the FILLER test, not a length. #397 round 4
 * (WhollyMindless): the cutoff here was 16 characters, so `Never` was dropped
 * from `Never \`npm run deploy\`.` and an empty list was then read as proof that
 * the whole candidate was restatable. A short fragment is where a prohibition, a
 * window or a number lives; punctuation and "ship with" are what a fragment has
 * to be before it is ignored.
 */
function claims(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[.;:,\n]/)) {
    const c = part.trim();
    if (!c) continue;
    const words = c.split(/[^a-z0-9']+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words.every((w) => FILLER.has(w))) continue;
    out.push(c);
  }
  return out;
}

/**
 * Does a sentence that states one of `commands` also FORBID it? Judged on those
 * sentences alone: the manifest says a command exists, so "Never run `x`" is a
 * claim the manifest does not make, while a prohibition in an unrelated clause is
 * that clause's business and the claim check handles it.
 *
 * The bare words are here because `polaritySigns` reads `never` as a modifier
 * that needs a verb, and "Never `npm run deploy`." has the verb inside a code
 * span. A closed list, answering one closed question, over a decision that can
 * now only decline to tag.
 */
function forbidsCommand(content: string, commands: string[]): boolean {
  for (const sentence of content.split(/[.;:\n]+/)) {
    if (!commands.some((c) => sentence.includes(c))) continue;
    if (
      negated(sentence) ||
      /\b(never|avoid\w*|prohibit\w*|forbid\w*)\b/i.test(sentence)
    )
      return true;
  }
  return false;
}

/** The whole sentence around `start .. start+len`, with the offset it starts at. */
function sentenceSpan(
  text: string,
  start: number,
  len: number,
): { text: string; at: number } {
  let a = start;
  while (a > 0 && !isBoundary(text.charCodeAt(a - 1))) a--;
  let b = start + len;
  while (b < text.length && !isBoundary(text.charCodeAt(b))) b++;
  return { text: text.slice(a, b), at: a };
}

/**
 * VETO 1b (#403 review): does this prefix WARN AGAINST the claim that follows?
 *
 * `Stop assuming the cache supports TTL expiration.` contains the affirmative
 * sentence `The cache supports TTL expiration.` as the object of `stop assuming`.
 * A substring test plus cue equality merges a warning with the claim it warns
 * against, because the cue list carries neither `stop` nor `drop` — and neither
 * does `polaritySigns`, so widening it the way an earlier round tried does not
 * catch this either. Measured on 05482ba: both `Stop assuming X` and `Drop the
 * assumption that X` tagged `X` as restatable.
 *
 * The veto reads the words between the sentence start and the hit, not the whole
 * sentence, and that is what keeps it cheap in tags. `The parser drops stale
 * entries.` states its claim and keeps its tag, because `drops` there governs
 * `stale entries`, not a following assertion; the ambiguous verbs are therefore
 * veto words only when a claim noun follows them. Every veto declines to tag,
 * which is the direction this file fails safe in.
 */
const WARNS_AGAINST = new RegExp(
  // One alternation, ONE shared tail. Written as three separate alternatives
  // each ending in `$`, only the last would be anchored and the first would
  // match any sentence that merely contains `stop` anywhere — measured, and it
  // cost the tag from `The job stops at midnight and the cache supports TTL
  // expiration.`, which states its claim plainly.
  "(?:" +
    // A deterrent verb needs no framing: what follows is being warned against.
    "\\b(?:stop|stops|stopped|stopping|cease|ceases|ceased|quit|quits|quitting|beware|caution\\w*)\\b" +
    // An ordinary verb becomes a deterrent only with a claim noun behind it.
    "|\\b(?:drop|drops|dropped|dropping|discard\\w*|dismiss\\w*|reject\\w*|forget|forgets|forgot|forgetting|ignor\\w*|overlook\\w*)\\b\\s+(?:the|your|this|an|any)\\s+(?:assumption|assumptions|idea|ideas|notion|notions|belief|beliefs|thinking|fact)\\b" +
    // Claim verbs govern whatever follows them, framed or not.
    "|\\b(?:assume|assumes|assumed|assuming|believ\\w*|think|thinks|thought)\\b" +
    // Optional `that`, then nothing: the claim starts here.
    ")\\s*(?:that\\s*)?$",
  "i",
);

function warnsAgainst(prefix: string): boolean {
  return WARNS_AGAINST.test(prefix);
}

/**
 * Where the tree states `clause` as its own words, in a sentence of the same
 * polarity. -1 means "not available".
 *
 * #397 round 3 (WhollyMindless): a bare `indexOf` matches INSIDE the opposite
 * assertion. With `We do not use tabs for indentation.` in the README, the
 * candidate `Use tabs for indentation.` was refused as available, so the store
 * would have held the reversal of the rule the gate had just read. A hit now
 * has to
 *   - begin and end on a word boundary: `use tabs` is not a hit inside
 *     `abuse tabs`; and
 *   - sit in a sentence that shares the clause's polarity. Negation the tree
 *     carries and the clause drops is a reversal, not a restatement; and
 *   - not be the object of a warning. `Stop assuming X.` states `X` only to
 *     reject it, and no polarity test of any breadth sees that (VETO 1b).
 * A reversed clause is not evidence of availability, and every uncertainty in
 * this file keeps the candidate.
 */
function findClause(hay: string, clause: string): number {
  const reversed = cueNegated(clause);
  for (let from = 0; ; ) {
    const i = hay.indexOf(clause, from);
    if (i < 0) return -1;
    const before = i > 0 ? hay.charCodeAt(i - 1) : 32;
    const after =
      i + clause.length < hay.length ? hay.charCodeAt(i + clause.length) : 32;
    const sentence = sentenceSpan(hay, i, clause.length);
    if (
      !/\w/.test(String.fromCharCode(before)) &&
      !/\w/.test(String.fromCharCode(after)) &&
      cueNegated(sentence.text) === reversed &&
      // A later occurrence may state the claim plainly, so a vetoed hit is
      // skipped rather than ending the search.
      !warnsAgainst(hay.slice(sentence.at, i))
    )
      return i;
    from = i + 1;
  }
}

/** True when every assertion in `clauses` is restatable from `hay`. */
function allRestatable(hay: string, clauses: string[]): boolean {
  return hay !== "" && clauses.every((c) => findClause(hay, c) >= 0);
}

export interface AvailabilityIndex {
  /** Null means "cannot tell", which stores the row with no tag. */
  check(content: string): AvailabilityVerdict | null;
  /**
   * For evidence: what the tree scan actually read. `capped` means the byte
   * budget ran out before the tracked list did. It is telemetry only, never a
   * verdict input: both rules assert PRESENCE ("the tree states this"), so a
   * truncated scan can only lower the tag rate, never raise a false tag.
   */
  scanned(): {
    files: number;
    bytes: number;
    tracked: boolean;
    capped: boolean;
  };
}

/**
 * One index per capture pass: git is asked once, the byte budget is shared by
 * every candidate in the pass, and the gate declarations are read once.
 */
export function availabilityIndex(
  repoDir: string | undefined,
): AvailabilityIndex {
  if (!repoDir) {
    return {
      check: () => null,
      scanned: () => ({ files: 0, bytes: 0, tracked: false, capped: false }),
    };
  }
  const files = listed(repoDir);
  if (files === null) {
    return {
      check: () => null,
      scanned: () => ({ files: 0, bytes: 0, tracked: false, capped: false }),
    };
  }
  const gates = parseGates(repoDir, files);
  const ranked = [...files]
    .filter((f) => !skipPath(f) && TEXT_EXTENSIONS.has(extOf(f)))
    .sort((a, b) => {
      const pa = PRIORITY.indexOf(extOf(a));
      const pb = PRIORITY.indexOf(extOf(b));
      const ra = pa === -1 ? PRIORITY.length : pa;
      const rb = pb === -1 ? PRIORITY.length : pb;
      return ra - rb || (a < b ? -1 : 1);
    });

  let haystack = "";
  const slices: Slice[] = [];
  let bytes = 0;
  let loaded = 0;
  // Set only when a file is actually SKIPPED, which is what the field claims: a
  // final file that pushes the total past the cap sets nothing, because nothing
  // was left behind. `bytes` counts decoded characters, not octets on disk — the
  // budget is a work bound, not a disk measurement.
  let capped = false;
  for (const file of ranked) {
    if (bytes >= TOTAL_CAP) {
      capped = true;
      break;
    }
    const text = readTracked(repoDir, file);
    if (text === null) continue;
    const n = norm(text);
    if (!n) continue;
    const start = haystack.length;
    haystack += n + "\u0000";
    slices.push({ file, start, end: haystack.length });
    bytes += text.length;
    loaded++;
  }

  const fileAt = (offset: number): string => {
    for (const s of slices)
      if (offset >= s.start && offset < s.end) return s.file;
    return "?";
  };

  return {
    check(content: string): AvailabilityVerdict | null {
      // #397 review (WhollyMindless): matching PART of a candidate does not
      // establish the WHOLE fact is available. Both rules used to refuse on
      // one hit, which lost new facts riding a restated fragment — exactly
      // the rows this gate exists to preserve:
      //   - a README rule + "; Finance confirmed the supplier rate is 1900"
      //     refused on the old clause;
      //   - "Never run `npm run deploy` until finance confirms approval code
      //     BLUEBIRD" refused because the manifest declares `deploy`, although
      //     the restriction and the code appear nowhere.
      // A tag requires EVERY assertion the candidate makes to be restatable.
      const whole = norm(content);
      const needed = claims(whole);
      if (needed.length === 0) needed.push(whole);
      const first = needed[0] ?? whole;
      // Evidence mirror of `whole` and `first`, scrubbed WHILE THE TEXT STILL HAS
      // ITS CASE. `norm()` lowercases, and the prefix scrubber in
      // store/secrets.ts matches `AKIA[A-Z0-9]{16}` case-sensitively, so a span
      // normalised before scrubbing keeps a fully recoverable access key: the
      // logged `akia1234567890abcdef` uppercases straight back to the secret
      // (#403 review). Redacting `avail.matched` later cannot recover what
      // normalisation already destroyed, so this is the only place it can be
      // done. Verdict logic reads `needed`/`first`, never these.
      const safeWhole = norm(redactSecrets(content));
      const safeFirst = claims(safeWhole)[0] ?? safeWhole;
      if (haystack && allRestatable(haystack, needed)) {
        return {
          reason: "in_tracked_file",
          where:
            relative(
              repoDir,
              join(repoDir, fileAt(findClause(haystack, first))),
            ) || "?",
          matched: safeFirst.slice(0, 120),
        };
      }
      // Declared gate. Round 3 (WhollyMindless) removed the LENGTH test: a short
      // residual used to count as a restatement, so "`npm run deploy` wipes the
      // staging database." was refused against a manifest that says only that
      // `deploy` runs rsync. Round 4 found the same defect still open, in two
      // places that both throw information away BEFORE deciding:
      //   - every command span was stripped after ONE declared gate was found,
      //     so "Before `npm run deploy`, run `aws sso login --profile prod`."
      //     refused with the undeclared AWS prerequisite erased from the row;
      //   - an EMPTY claim list counted as proof, so "Never `npm run deploy`."
      //     refused with its only claim — `never` — dropped as too short.
      // A gate tag needs all three, each positively established:
      //   1. every command span the row states is declared. An undeclared one is
      //      a fact the tree does not hold, whatever the rest of the row says;
      //   2. what survives stripping them is nothing but FILLER — the bare
      //      mention "ship with X", which is what the manifest does declare; or
      //   3. otherwise, every assertion left in it is one the tracked files
      //      state themselves.
      const spans = statedCommands(content);
      const gate = gateHit(spans, gates);
      if (gate) {
        // VETOES (#402). The manifest states that a command EXISTS. It does not
        // state that the command is safe, allowed, or finished, and it carries
        // no figure. So a sentence that forbids the command, or a number the
        // command does not carry, is a claim the declaration cannot answer.
        //
        // These REMOVE a tag and never add one, and a removed tag costs the row
        // nothing permanent: it is stored either way and a spare budget still
        // shows it. That asymmetry is the whole point of the change — the round-3
        // and round-4 arguments were really about a vocabulary that had to be
        // perfect because a miss deleted a fact. Under a tag, a miss costs one
        // injection slot.
        if (forbidsCommand(content, spans)) return null;
        if (introducesNewNumber(content, spans.join(" "))) return null;
        const undeclared = spans.some((s) => gateHit([s], gates) === null);
        let residual = content;
        for (const span of spans) residual = residual.split(span).join(" ");
        const rest = claims(norm(residual));
        if (
          !undeclared &&
          (rest.length === 0 || allRestatable(haystack, rest))
        ) {
          return {
            reason: "declared_gate",
            where: gate.where,
            matched: safeWhole.slice(0, 120),
          };
        }
      }
      return null;
    },
    scanned: () => ({ files: loaded, bytes, tracked: true, capped }),
  };
}
