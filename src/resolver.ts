// GATE-1 resolver. Extracts embedded path/symbol refs from a memory/evidence
// candidate and re-resolves them against the live source tree (and, when
// OPENCODE_CBM_BIN is set, the codebase-memory-mcp file graph). Deterministic:
// regex + balanced-paren scanning, no model involvement.
import { join } from "node:path";
import { opendir } from "node:fs/promises";
import { type Memory } from "./memory.ts";

export interface CallForm {
  symbol: string;
  name: string;
  ownerPath: string;
  fileHint?: string;
  argsText: string;
}

export interface DriftInfo {
  symbol: string;
  from: string;
  to: string;
  source: "candidate" | "indexed";
  file?: string;
}

export interface Gate1Result {
  refs: number;
  resolved: string[];
  drift: DriftInfo | null;
  candidateStale: boolean;
  // Directory-qualified path refs that do NOT exist under liveRoot. A settled
  // claim citing one is hallucinated or machine-specific data.
  missingPaths: string[];
}

export function balancedParen(text: string, openIdx: number): { inner: string; end: number } | null {
  if (text[openIdx] !== "(") return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { inner: text.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

const CALL_RE = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;

// Last dotted segment is a known file extension: `package.json(committed by…)`
// is a file reference followed by parenthetical prose, not a call to a method
// named `json`.
const FILE_EXT = new Set([
  "json", "jsonc", "jsonl", "logfmt", "md", "mdx", "ts", "tsx", "js", "jsx",
  "mjs", "cjs", "py", "go", "rs", "rb", "java", "kt", "sh", "bash", "zsh",
  "yaml", "yml", "toml", "ini", "conf", "cfg", "txt", "csv", "html", "htm",
  "css", "scss", "xml", "sql", "tf", "lock", "log", "env",
]);

// Parenthetical PROSE is not a code call signature. A code-like arg list is
// empty or contains code punctuation ({ } ( ) : = , . < > quotes); the markers
// [ ] @ / never appear in the arg snippets drift detection cares about, and
// bare multi-word English with no code punctuation ("main-agent review fix")
// is prose.
function looksProseArgs(inner: string): boolean {
  const s = inner.trim();
  if (!s) return false;
  if (/[[\]@/]/.test(s)) return true;
  if (/[{}():=",.<>'"`]/.test(s)) return false;
  return s.split(/\s+/).length >= 2;
}

// Regex scanning ceiling: PATH_RE backtracks super-linearly on
// long word-character runs (200KB of base64 as memory content hung the gate
// on the service event loop; ~6s already at 100KB). The write gate rejects
// content far above this ceiling upstream; the bails protect every scanner
// from legacy oversized rows and any direct caller.
export const REGEX_SCAN_MAX_CHARS = 10_000;

export function extractCallForms(content: string): CallForm[] {
  if (content.length > REGEX_SCAN_MAX_CHARS) return [];
  const forms: CallForm[] = [];
  CALL_RE.lastIndex = 0;
  for (;;) {
    const m = CALL_RE.exec(content);
    if (!m) break;
    const symbol = m[1];
    const openIdx = content.indexOf("(", m.index + symbol.length);
    const paren = openIdx >= 0 ? balancedParen(content, openIdx) : null;
    if (!paren) continue;
    const parts = symbol.split(".");
    const name = parts[parts.length - 1];
    if (FILE_EXT.has(name.toLowerCase())) continue;
    if (looksProseArgs(paren.inner)) continue;
    const ownerPath = parts.slice(0, -1).join(".");
    forms.push({
      symbol,
      name,
      ownerPath,
      fileHint: parts.length >= 2 ? parts[parts.length - 2] : undefined,
      argsText: paren.inner,
    });
  }
  return forms;
}

// The extension must end the name: without the lookahead `Button.tsx` matched
// as `Button.ts` and `config.json` as `config.js`, and the existence check then
// blocked real files. `.tsx.snap` and `.js.map` are other files, not refs; a
// sentence-ending `.` still ends the ref.
const PATH_RE = /[A-Za-z0-9_@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)(?!\w|\.\w)(?::\d+)?/g;

export function extractPathRefs(content: string): string[] {
  if (content.length > REGEX_SCAN_MAX_CHARS) return [];
  return [...content.matchAll(PATH_RE)].map((m) => m[0]);
}

// Directory-qualified, repo-relative path refs whose existence gate1 can check
// against liveRoot. Skipped: bare names (`undo.ts` may live anywhere),
// absolute paths and `..` (another checkout's truth), URLs (`//`), and refs
// whose match starts just after `$` or `~` — env vars and home paths describe
// another machine, e.g. in `$BUILD_ROOT/src/a.ts` the regex match is
// `BUILD_ROOT/src/a.ts`, which the preceding-char check drops.
export function checkablePathRefs(content: string): string[] {
  if (content.length > REGEX_SCAN_MAX_CHARS) return [];
  const out: string[] = [];
  for (const m of content.matchAll(PATH_RE)) {
    const ref = m[0].replace(/:\d+$/, "");
    const prev = m.index && m.index > 0 ? content[m.index - 1] : "";
    if (prev === "$" || prev === "~" || prev === "/") continue;
    if (!ref.includes("/")) continue;
    if (ref.includes("//") || ref.startsWith("/") || ref.split("/").includes("..")) continue;
    // A dotted first segment reads as a hostname (opencode.ai/x/index.ts), not
    // a repo directory. `.` itself is the legitimate relative root prefix.
    const first = ref.split("/")[0];
    if (first.includes(".") && first !== ".") continue;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    // A listing that yields even one entry proves liveRoot is a real tree;
    // a missing path throws ENOENT/ENOTDIR and fails open (nothing verifiable).
    for (const _ of new Bun.Glob("*").scanSync({ onlyFiles: false, cwd: path })) {
      void _;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function splitTopLevel(argsText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < argsText.length; i++) {
    const c = argsText[i];
    if (quote) {
      current += c;
      if (c === "\\") {
        current += argsText[++i] ?? "";
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      current += c;
      continue;
    }
    if ("([{<".includes(c)) depth++;
    if (")]}>".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// Canonicalize an argument list to its parameter names so that type
// annotations and defaults do not read as signature changes:
// `config: any, opts = {}` -> `config, opts`.
// A TS `_` prefix on an unused parameter (`_name`, `_size`) is stripped so the
// same identifier with and without the underscore reads as the same name.
export function normalizeArgs(argsText: string): string {
  return splitTopLevel(argsText)
    .map((a) => {
      let t = a.split("=")[0] ?? a;
      t = t.split(":")[0] ?? t;
      t = t.trim().replace(/^_/, "").replace(/\?$/, "").trim();
      return t;
    })
    .filter(Boolean)
    .join(", ");
}

// Prefix-aware signature drift. A memory states only the args it actually
// names; trailing live params it omits (scene?, updatable?) are not drift.
// Drift is a positional mismatch at any stated index, or a claim that the live
// signature dropped (candidate has more args than live).
export function sameArgs(candidate: string, live: string): boolean {
  const c = splitTopLevel(normalizeArgs(candidate));
  const l = splitTopLevel(normalizeArgs(live));
  if (c.length === 0) return true;
  if (c.length > l.length) return false;
  return c.every((a, i) => a === l[i]);
}

export function displayCall(name: string, argsText: string): string {
  return `${name}(${normalizeArgs(argsText)})`;
}

// Deterministic source-tree scan used by GATE-1 live resolution. Excludes junk
// that poisons signature comparison: node_modules (type-decl .d.ts files often
// carry empty or spread args), build output (dist/lib), and VCS dirs. Prefers
// files under src/ over build output, .ts/.tsx sources over compiled .js, and
// case-insensitively ranks basenames matching the call's fileHint first so
// `MeshBuilder.CreateBox` resolves to `meshbuilder.pure.ts` instead of a
// different file that merely also calls CreateBox.
const SKIP_DIRS = ["node_modules", ".git", ".hg", ".svn"];
const SOURCE_EXTS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];

function relRank(rel: string): number {
  const seg = rel.split("/");
  if (seg.some((s) => SKIP_DIRS.includes(s))) return Infinity;
  if (rel.endsWith(".d.ts")) return Infinity;
  let rank = 0;
  if (seg.includes("src")) rank -= 100;
  if (rel.endsWith(".d.ts")) rank += 1000;
  if (seg.some((s) => ["dist", "build", "out", "lib"].includes(s))) rank += 50;
  if (/\.(js|mjs|cjs)$/.test(rel)) rank += 10;
  return rank;
}

// One recursive walk enumerates the source tree, shared by every resolution
// in a gate run instead of a glob pass per extension per call form. Semantics
// match Bun.Glob defaults: dot entries are skipped, symlinks (file or dir)
// are neither listed nor traversed, extensions match case-sensitively.
async function walkSources(absDir: string, relDir: string, out: string[]): Promise<void> {
  let dh: Awaited<ReturnType<typeof opendir>>;
  try {
    dh = await opendir(absDir);
  } catch {
    return; // Non-existent/unreadable root -> no candidates.
  }
  try {
    for await (const ent of dh) {
      if (ent.name.startsWith(".")) continue;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.includes(ent.name)) {
          await walkSources(join(absDir, ent.name), relDir ? `${relDir}/${ent.name}` : ent.name, out);
        }
      } else if (ent.isFile()) {
        const dot = ent.name.lastIndexOf(".");
        if (dot > 0 && SOURCE_EXTS.includes(ent.name.slice(dot + 1))) out.push(relDir ? `${relDir}/${ent.name}` : ent.name);
      }
    }
  } catch {
    // Directory vanished mid-walk: keep what was collected.
  } finally {
    // Close by awaiting, never by chaining off the return value: Bun 1.3.10
    // returns undefined from DirHandle.close() (there the old `.catch()` chain
    // threw a TypeError that killed the walk), 1.4.4 returns a Promise, and
    // awaiting serves both — the optional call covers runtimes without it.
    try {
      await dh.close?.();
    } catch {
      // The walk is done: a handle that refuses to close is GC's problem.
    }
  }
}

// Tree file list + lazily cached file texts, shared by ALL resolution work in
// one gate run: gate1's candidate forms and gate2's per-memory stale scan read
// each source file at most once per write instead of once per call form.
export interface TreeIndex {
  files: string[];
  texts: Map<string, string>;
}

export async function buildTreeIndex(liveRoot: string): Promise<TreeIndex> {
  const out: string[] = [];
  await walkSources(liveRoot, "", out);
  return { files: [...new Set(out)].filter((f) => relRank(f) < Infinity), texts: new Map() };
}

export type LazyTree = () => Promise<TreeIndex>;

// Memoized builder: the index is constructed on first use and reused by every
// later caller within the same gate run.
export function memoTree(liveRoot: string): LazyTree {
  let p: Promise<TreeIndex> | undefined;
  return () => (p ??= buildTreeIndex(liveRoot));
}

async function textOf(index: TreeIndex, abs: string): Promise<string | null> {
  const cached = index.texts.get(abs);
  if (cached !== undefined) return cached;
  try {
    const text = await Bun.file(abs).text();
    index.texts.set(abs, text);
    return text;
  } catch {
    return null;
  }
}

function hintBoost(rel: string, hint: string): number {
  const base = rel.split("/").pop()!.toLowerCase();
  if (base.startsWith(hint)) return 4;
  if (base.includes(hint)) return 3;
  return 0;
}

// First live definition of `name` in the source tree, falling back to the
// first call site. A definition found anywhere beats a call site that sorts
// earlier: `MeshBuilder.CreateBox`'s real signature lives in
// boxBuilder.pure.ts (a facade property in meshBuilder.pure.ts re-imports it),
// but a call site in an alphabetically-earlier file must not shadow it.
export async function findLiveCall(
  name: string,
  fileHint: string | undefined,
  liveRoot: string,
  tree?: TreeIndex,
): Promise<{ file: string; argsText: string } | null> {
  const index = tree ?? (await buildTreeIndex(liveRoot));
  const files = [...index.files];
  const tiebreak = (a: string, b: string) => a.localeCompare(b);
  if (fileHint) {
    const h = fileHint.toLowerCase();
    files.sort((a, b) => relRank(a) - relRank(b) || hintBoost(b, h) - hintBoost(a, h) || tiebreak(a, b));
  } else {
    files.sort((a, b) => relRank(a) - relRank(b) || tiebreak(a, b));
  }
  const defRe = new RegExp(`(?:function|const|class|var|static)\\s+${name}\\b`);
  const callRe = new RegExp(`\\b${name}\\s*\\(`);

  let fallback: { file: string; argsText: string } | null = null;
  // Reads go out in bounded-parallel chunks but are evaluated in priority
  // order, so "first definition wins" is unchanged — only its latency is.
  const CHUNK = 32;
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK);
    const texts = await Promise.all(chunk.map((rel) => textOf(index, join(liveRoot, rel))));
    for (let j = 0; j < chunk.length; j++) {
      const text = texts[j];
      if (text === null || !text.includes(name)) continue;
      const rel = chunk[j];
      const defMatch = defRe.exec(text);
      if (defMatch) {
        const idx = text.indexOf("(", defMatch.index + defMatch[0].length);
        const paren = idx >= 0 ? balancedParen(text, idx) : null;
        if (paren) return { file: join(liveRoot, rel), argsText: paren.inner };
      }
      if (!fallback) {
        const callMatch = callRe.exec(text);
        if (callMatch) {
          const idx = text.indexOf("(", callMatch.index);
          const paren = idx >= 0 ? balancedParen(text, idx) : null;
          if (paren) fallback = { file: join(liveRoot, rel), argsText: paren.inner };
        }
      }
    }
  }
  return fallback;
}

// The signature a memory/evidence already embeds for `symbol` in `scope`.
export function indexedSignature(symbol: string, scope: Memory[]): CallForm | null {
  for (const m of scope) {
    for (const form of extractCallForms(m.content)) {
      if (form.symbol === symbol) return form;
    }
  }
  return null;
}

export interface ResolveInput {
  content: string;
  scope: string;
  liveRoot: string;
  scopeMemories: Memory[];
  // Shared (memoized) tree index for this gate run; built on first use.
  // Omitted callers resolve against their own single-use index.
  tree?: LazyTree;
}

export async function gate1(input: ResolveInput): Promise<Gate1Result> {
  const forms = extractCallForms(input.content);
  const pathRefs = extractPathRefs(input.content);
  const refs = forms.length + pathRefs.length;
  if (refs === 0) return { refs: 0, resolved: [], drift: null, candidateStale: false, missingPaths: [] };

  let drift: DriftInfo | null = null;
  const resolved: string[] = [];

  // Existence check for repo-relative path refs. When liveRoot is not a real
  // tree (unit tests, deleted worktree) nothing is verifiable, so report no
  // missing paths rather than flagging everything.
  const missingPaths: string[] = [];
  if (await isDirectory(input.liveRoot)) {
    for (const ref of checkablePathRefs(input.content)) {
      if (!(await Bun.file(join(input.liveRoot, ref)).exists())) missingPaths.push(ref);
    }
  }

  if (forms.length) {
    const tree = await (input.tree ?? memoTree(input.liveRoot))();
    for (const form of forms) {
      resolved.push(form.symbol);
      const live = await findLiveCall(form.name, form.fileHint, input.liveRoot, tree);
      if (!live) continue;
      const indexed = indexedSignature(form.symbol, input.scopeMemories);
      const candidateDiffers = !sameArgs(form.argsText, live.argsText);
      const indexedDiffers = indexed ? !sameArgs(indexed.argsText, live.argsText) : false;
      if (candidateDiffers) {
        drift = {
          symbol: form.symbol,
          from: displayCall(form.name, form.argsText),
          to: displayCall(form.name, live.argsText),
          source: "candidate",
          file: live.file,
        };
      } else if (indexedDiffers && indexed) {
        drift = {
          symbol: form.symbol,
          from: displayCall(form.name, indexed.argsText),
          to: displayCall(form.name, live.argsText),
          source: "indexed",
          file: live.file,
        };
      }
    }
  }

  return {
    refs,
    resolved,
    drift,
    candidateStale: drift?.source === "candidate",
    missingPaths,
  };
}
