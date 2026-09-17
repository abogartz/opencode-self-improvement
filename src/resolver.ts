// GATE-1 resolver. Extracts embedded path/symbol refs from a memory/evidence
// candidate and re-resolves them against the live source tree (and, when
// OPENCODE_CBM_BIN is set, the codebase-memory-mcp file graph). Deterministic:
// regex + balanced-paren scanning, no model involvement.
import { join } from "node:path";
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

export function extractCallForms(content: string): CallForm[] {
  const forms: CallForm[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(content)) !== null) {
    const symbol = m[1];
    const openIdx = content.indexOf("(", m.index + symbol.length);
    const paren = openIdx >= 0 ? balancedParen(content, openIdx) : null;
    if (!paren) continue;
    const parts = symbol.split(".");
    const name = parts[parts.length - 1];
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

const PATH_RE = /[A-Za-z0-9_@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)(?::\d+)?/g;

export function extractPathRefs(content: string): string[] {
  return [...content.matchAll(PATH_RE)].map((m) => m[0]);
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
export function normalizeArgs(argsText: string): string {
  return splitTopLevel(argsText)
    .map((a) => {
      let t = a.split("=")[0] ?? a;
      t = t.split(":")[0] ?? t;
      return t.trim().replace(/\?$/, "").trim();
    })
    .filter(Boolean)
    .join(", ");
}

export function sameArgs(a: string, b: string): boolean {
  return normalizeArgs(a) === normalizeArgs(b);
}

export function displayCall(name: string, argsText: string): string {
  return `${name}(${normalizeArgs(argsText)})`;
}

async function globFiles(patterns: string[], root: string): Promise<string[]> {
  const out = new Set<string>();
  for (const p of patterns) {
    const glob = new Bun.Glob(p);
    try {
      for await (const f of glob.scan(root)) out.add(join(root, f));
    } catch {
      // Glob.scan throws on a non-existent root; treat as no candidates.
    }
  }
  return [...out].sort();
}

// First live call occurrence of `name` in a matching file. Prefers a
// function/method definition, falls back to the first call site.
export async function findLiveCall(
  name: string,
  fileHint: string | undefined,
  liveRoot: string,
): Promise<{ file: string; argsText: string } | null> {
  const patterns: string[] = [];
  if (fileHint) {
    for (const ext of ["ts", "tsx", "js", "jsx", "mjs", "cjs"]) {
      patterns.push(`**/${fileHint}.${ext}`);
    }
  }
  let files = await globFiles(patterns, liveRoot);
  if (!files.length) files = await globFiles(["**/*.ts", "**/*.js"], liveRoot);

  for (const file of files) {
    let text: string;
    try {
      text = await Bun.file(file).text();
    } catch {
      continue;
    }
    let idx = -1;
    const defMatch = new RegExp(`function\\s+${name}\\b`).exec(text);
    if (defMatch) {
      idx = text.indexOf("(", defMatch.index + defMatch[0].length);
    } else {
      const callMatch = new RegExp(`\\b${name}\\s*\\(`).exec(text);
      if (callMatch) idx = text.indexOf("(", callMatch.index);
    }
    if (idx === -1) continue;
    const paren = balancedParen(text, idx);
    if (paren) return { file, argsText: paren.inner };
  }
  return null;
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
}

export async function gate1(input: ResolveInput): Promise<Gate1Result> {
  const forms = extractCallForms(input.content);
  const pathRefs = extractPathRefs(input.content);
  const refs = forms.length + pathRefs.length;
  if (refs === 0) return { refs: 0, resolved: [], drift: null, candidateStale: false };

  let drift: DriftInfo | null = null;
  const resolved: string[] = [];

  for (const form of forms) {
    resolved.push(form.symbol);
    const live = await findLiveCall(form.name, form.fileHint, input.liveRoot);
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

  return {
    refs,
    resolved,
    drift,
    candidateStale: drift?.source === "candidate",
  };
}
