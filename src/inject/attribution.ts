// Memory attribution: which of this session's answers came from an injected
// memory instead of re-deriving the fact from the filesystem. Pure and
// deterministic — no model, no I/O, no ambient clock. The caller (src/index.ts)
// feeds it the session's tool ledger and the refs cited by the memories that
// were actually injected this session, and renders the result through the
// shared status builders (tool + TUI panel stay 1:1).
//
// Epistemics (label every number by how it was obtained):
//   [measured]  an observed fact about tool calls that did or did not happen.
//   [inferred]  a coverage statement — memory named something the agent did not
//               re-read — which is consistent with "memory answered it" but does
//               not prove the model used it. Never presented as a certainty.
import { extractPathRefs } from "../gate/resolver.ts";
import type { Memory } from "../store/model/memory.ts";

// A tool call as recorded by the ledger (see src/state.ts ToolResult). Only the
// fields attribution needs; extra fields are ignored.
export interface CallLike {
  tool: string;
  arg?: string;
  ts: string;
}

// Facts the injected memories assert, used as the join key against tool calls.
export interface MemoryRefs {
  paths: string[]; // repo-relative code paths the memories cite
  commands: string[]; // shell commands the memories state (backticked)
}

export interface Attribution {
  // Tier A — command reuse [measured]: the agent ran a remembered command
  // without first reading/searching for its terms.
  commandSaves: number;
  commandsMatched: number; // remembered commands the agent did run
  // Tier B — file coverage: memory named a path; did the agent re-open it?
  pathsCited: number;
  pathsReRead: number; // [measured] cited path WAS opened again this session
  pathsSkipped: number; // [inferred] cited path NOT opened this session
  // Honest denominator for "new work": file lookups memory did not cover.
  readsTotal: number;
  readsNotCovered: number; // [measured] reads of paths no memory cited
}

const READ_TOOLS = new Set(["read", "glob", "grep"]);
const BASH_TOOLS = new Set(["bash", "shell"]);

// Command-shaped bins. A backticked span only counts as a remembered command
// if it starts with a known runner/build tool AND has arguments, so prose like
// `the store` or `src/gates.ts` is never mistaken for a command.
const BIN_RE =
  /^(?:bun|bunx|npm|npx|pnpm|yarn|node|make|go|cargo|pytest|tsc|gh|git|docker|python3?|deno|uv|pip3?)(?:\s|$)/;

// Small words that carry no lookup signal; a command "save" is credited only
// when nothing the agent read earlier mentioned a distinctive term.
const STOP = new Set(["run", "the", "and", "for", "with", "to", "all", "test", "tests"]);

function norm(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Backticked shell commands a memory asserts. Conservative on purpose: false
// positives here would inflate the headline "saves" number, so we require a
// known bin plus at least one argument.
export function extractCommandRefs(content: string): string[] {
  if (content.length > 10_000) return [];
  const out: string[] = [];
  for (const m of content.matchAll(/`([^`\n]{2,120})`/g)) {
    const s = (m[1] ?? "").trim();
    if (s.includes(" ") && BIN_RE.test(s)) out.push(s);
  }
  return [...new Set(out)];
}

export function deriveMemoryRefs(mems: Memory[]): MemoryRefs {
  const paths = new Set<string>();
  const commands = new Set<string>();
  for (const m of mems) {
    for (const p of extractPathRefs(m.content)) paths.add(p.replace(/:\d+$/, ""));
    for (const c of extractCommandRefs(m.content)) commands.add(c);
  }
  return { paths: [...paths], commands: [...commands] };
}

// A read/grep arg "hits" a cited path when they name the same file: exact,
// suffix, or same basename (memory cites `src/gates.ts`, the agent opened
// `/abs/src/gates.ts` or `gates.ts`). Deliberately loose — Tier B is coverage,
// not an exact-path proof.
function pathHit(arg: string, path: string): boolean {
  if (!arg || !path) return false;
  const base = path.split("/").pop() || path;
  return arg === path || arg.endsWith("/" + base) || path.endsWith("/" + arg) || arg.includes(path);
}

function distinctiveTokens(command: string): string[] {
  return command.split(/[^a-z0-9_.-]+/).filter((t) => t.length > 2 && !STOP.has(t) && !BIN_RE.test(t));
}

export function attributeSession(calls: CallLike[], refs: MemoryRefs): Attribution {
  const readCalls = calls.filter((c) => READ_TOOLS.has(c.tool));
  const bashCalls = calls.filter((c) => BASH_TOOLS.has(c.tool));

  // ---- Tier A: remembered command run without a prior lookup of its terms ----
  let commandSaves = 0;
  let commandsMatched = 0;
  const credited = new Set<string>();
  for (const b of bashCalls) {
    const arg = norm(b.arg);
    if (!arg) continue;
    for (const mem of refs.commands) {
      const mc = norm(mem);
      if (mc.length < 3 || credited.has(mc)) continue;
      if (!(arg.includes(mc) || mc.includes(arg))) continue;
      commandsMatched++;
      credited.add(mc);
      const terms = distinctiveTokens(mc);
      // "Looked it up" = an earlier file-touching call mentioned any distinctive
      // term of the command. If none did, the command came from context, not a
      // fresh search — attributable to memory (which was injected).
      const lookedUp = readCalls.some((r) => {
        if (!(r.ts < b.ts)) return false;
        const ra = norm(r.arg);
        return !!ra && terms.some((t) => ra.includes(t));
      });
      if (!lookedUp) commandSaves++;
      break;
    }
  }

  // ---- Tier B: coverage of the paths the memories named ----
  const readArgs = readCalls.map((c) => norm(c.arg)).filter(Boolean);
  let pathsReRead = 0;
  for (const p of refs.paths) {
    if (readArgs.some((ra) => pathHit(ra, norm(p)))) pathsReRead++;
  }
  const pathsCited = refs.paths.length;
  const pathsSkipped = pathsCited - pathsReRead;

  // ---- New work: file lookups no memory covered ----
  const readsNotCovered = readArgs.filter((ra) => !refs.paths.some((p) => pathHit(ra, norm(p)))).length;

  return {
    commandSaves,
    commandsMatched,
    pathsCited,
    pathsReRead,
    pathsSkipped,
    readsTotal: readArgs.length,
    readsNotCovered,
  };
}
