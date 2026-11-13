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
// Both REFUSE. Neither deletes: the caller drops a candidate BEFORE the write
// gate, so a row the store has always kept is never touched (criterion 6, the
// same monotonicity rule S1 shipped under).
//
// Fail-open is the rule throughout. A missing git, an unreadable file, a repo
// that is not a repo, or a budget that ran out is NOT evidence that a fact is
// available — refusing on those would lose the transport win, which is the one
// measured benefit capture has. Every uncertainty keeps the candidate.
import { lstatSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** What made a candidate available, and where the next session can get it. */
export type AvailabilityVerdict = {
  reason: "in_tracked_file" | "declared_gate";
  /** Repo-relative file, or the gate's location (`package.json scripts.test`). */
  where: string;
  /** The span that matched, for the evidence line. */
  matched: string;
};

// Below this a clause is punctuation, not a claim: `the build is green` matches
// anything. Above it a clause is an assertion, and that is where a short new
// fact lives — `; External rate is 1900` carries the whole number in 21
// characters (#397 review, WhollyMindless). So every clause above MIN_TRACE has
// to be found before the candidate is refused.
const MIN_TRACE = 16;

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
 * The assertions in a normalised text: what is left after splitting on the
 * sentence boundaries, minus fragments too short to be a claim.
 */
function assertions(text: string): string[] {
  return text
    .split(/[.;:,\n]/)
    .map((c) => c.trim())
    .filter((c) => c.length >= MIN_TRACE);
}

/** The whole sentence around `start .. start+len`, walked out to the boundaries. */
function sentenceAt(text: string, start: number, len: number): string {
  let a = start;
  while (a > 0 && !isBoundary(text.charCodeAt(a - 1))) a--;
  let b = start + len;
  while (b < text.length && !isBoundary(text.charCodeAt(b))) b++;
  return text.slice(a, b);
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
 *     carries and the clause drops is a reversal, not a restatement.
 * A reversed clause is not evidence of availability, and every uncertainty in
 * this file keeps the candidate.
 */
function findClause(hay: string, clause: string): number {
  const negated = NEGATION.test(clause);
  for (let from = 0; ; ) {
    const i = hay.indexOf(clause, from);
    if (i < 0) return -1;
    const before = i > 0 ? hay.charCodeAt(i - 1) : 32;
    const after =
      i + clause.length < hay.length ? hay.charCodeAt(i + clause.length) : 32;
    if (
      !/\w/.test(String.fromCharCode(before)) &&
      !/\w/.test(String.fromCharCode(after)) &&
      NEGATION.test(sentenceAt(hay, i, clause.length)) === negated
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
  /** Null means "cannot tell", which keeps the candidate. */
  check(content: string): AvailabilityVerdict | null;
  /** For evidence: whether the tree scan ran at all. */
  scanned(): { files: number; bytes: number; tracked: boolean };
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
      scanned: () => ({ files: 0, bytes: 0, tracked: false }),
    };
  }
  const files = listed(repoDir);
  if (files === null) {
    return {
      check: () => null,
      scanned: () => ({ files: 0, bytes: 0, tracked: false }),
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
  for (const file of ranked) {
    if (bytes >= TOTAL_CAP) break;
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
      // Refusal requires EVERY assertion the candidate makes to be restatable.
      const whole = norm(content);
      const needed = assertions(whole);
      if (needed.length === 0) needed.push(whole);
      const first = needed[0] ?? whole;
      if (haystack && allRestatable(haystack, needed)) {
        return {
          reason: "in_tracked_file",
          where:
            relative(
              repoDir,
              join(repoDir, fileAt(findClause(haystack, first))),
            ) || "?",
          matched: first.slice(0, 120),
        };
      }
      // Declared gate. #397 round 3 (WhollyMindless): a short residual used to
      // count as a restatement on LENGTH alone, so "`npm run deploy` wipes the
      // staging database." was refused against a manifest that says only that
      // `deploy` runs rsync. Length and restriction vocabulary are both the
      // wrong test — any list of condition words is open-ended, and the row is
      // new whatever its length. The burden now sits where it belongs: refuse
      // only when the candidate is POSITIVELY recognised as a restatement of
      // the declaration, which means stripping the stated commands leaves either
      // no assertion at all, or assertions the tracked files state themselves.
      // Everything else is a claim the manifest does not make, and it is kept.
      const gate = gateHit(statedCommands(content), gates);
      if (gate) {
        let residual = content;
        for (const span of statedCommands(content))
          residual = residual.split(span).join(" ");
        const claims = assertions(norm(residual));
        if (claims.length === 0 || allRestatable(haystack, claims)) {
          return {
            reason: "declared_gate",
            where: gate.where,
            matched: whole.slice(0, 120),
          };
        }
      }
      return null;
    },
    scanned: () => ({ files: loaded, bytes, tracked: true }),
  };
}
