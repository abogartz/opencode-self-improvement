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

// Below this, a "verbatim" hit is coincidence: `the build is green` matches
// anything. A restated doc sentence is normally longer than this.
const MIN_CLAUSE = 48;
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
      // Gate first: it reads a handful of small files and is the stronger claim
      // (the project itself declares the command).
      const gate = gateHit(statedCommands(content), gates);
      if (gate) {
        return {
          reason: "declared_gate",
          where: gate.where,
          matched: norm(content).slice(0, 120),
        };
      }
      if (!haystack) return null;
      const whole = norm(content);
      const clauses = [whole, ...whole.split(/[.;:,\n]/)]
        .map((c) => c.trim())
        .filter((c) => c.length >= MIN_CLAUSE);
      for (const clause of clauses) {
        const at = haystack.indexOf(clause);
        if (at >= 0) {
          return {
            reason: "in_tracked_file",
            where: relative(repoDir, join(repoDir, fileAt(at))) || "?",
            matched: clause.slice(0, 120),
          };
        }
      }
      return null;
    },
    scanned: () => ({ files: loaded, bytes, tracked: true }),
  };
}
