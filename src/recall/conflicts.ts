// Contradiction surface (POC, bench FINDINGS §4). A user-guided row may
// declare ref (the code symbol its value is about), claim (the user's value)
// and klass (who holds authority). At render time the plugin reads the code —
// bounded, deterministic, NO model call — and a collision renders ONE flagged
// CONFLICT line whose Action is fixed by the class: behavior class trusts the
// code, spec class fixes it. #345 measured the alternative twice: a wrong
// guided row made the agent rewrite a correct constant (raw row) and the
// framing-only fix stayed a coin flip (2 harms in 5). The class rule held 6/6.
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative } from "node:path";
import type { Expression } from "@babel/types";
import { type Memory } from "../store/model/memory.ts";

export interface CodeFact {
  /** Repo-relative path where the declaration was read. */
  file: string;
  /** The declared literal, verbatim (trimmed). */
  value: string;
}

// Bounded opt-in scan: cap files, bytes per file, and directory depth. When
// a relevant source cannot be decided, keep the row's plain caveat.
const MAX_FILES = 300;
const MAX_FILE_BYTES = 256 * 1024;
const SCAN_DEPTH = 3;
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".opencode",
]);

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > SCAN_DEPTH || out.length > MAX_FILES) return;
  let entries: Dirent[];
  try {
    // Never turn a src/ link or a linked child into an out-of-repo code fact.
    if (!lstatSync(dir).isDirectory()) return;
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (out.length > MAX_FILES) return;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
        walk(join(dir, e.name), depth + 1, out);
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      if (dot >= 0 && EXTENSIONS.has(e.name.slice(dot)))
        out.push(join(dir, e.name));
    }
  }
}

// Parsing is paid only by opt-in code checks, never by the default OFF path.
const require = createRequire(import.meta.url);
let parser: typeof import("@babel/parser") | undefined;
const sourceParser = (): typeof import("@babel/parser") =>
  (parser ??= require("@babel/parser"));

function literalValue(
  node: Expression | null | undefined,
): string | number | boolean | null | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "StringLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "NumericLiteral":
      return Number.isFinite(node.value) ? node.value : undefined;
    case "UnaryExpression": {
      if (
        node.argument.type !== "NumericLiteral" ||
        !["+", "-"].includes(node.operator)
      )
        return undefined;
      const value = (node.operator === "-" ? -1 : 1) * node.argument.value;
      return Number.isFinite(value) ? value : undefined;
    }
    default:
      return undefined;
  }
}

/** null = target found but undecidable; undefined = no top-level declaration. */
function declaration(
  text: string,
  file: string,
  ref: string,
): string | null | undefined {
  const extension = extname(file);
  const plugins: import("@babel/parser").ParserPlugin[] = [];
  if (extension === ".ts" || extension === ".tsx") plugins.push("typescript");
  if (extension === ".tsx") plugins.push("jsx");
  const tree = sourceParser().parse(text, {
    sourceType: "unambiguous",
    plugins,
  });
  let found: string | undefined;
  for (const statement of tree.program.body) {
    const candidate =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (candidate?.type !== "VariableDeclaration" || candidate.kind !== "const")
      continue;
    for (const binding of candidate.declarations) {
      if (binding.id.type !== "Identifier" || binding.id.name !== ref) continue;
      if (
        found !== undefined ||
        literalValue(binding.init) === undefined ||
        binding.init?.start == null ||
        binding.init.end == null
      )
        return null;
      found = text.slice(binding.init.start, binding.init.end);
    }
  }
  return found;
}

function readBounded(file: string): string | undefined {
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
    // Bound the read too: a file growing after stat cannot make this path
    // allocate/read an arbitrarily large source file.
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    return length > MAX_FILE_BYTES
      ? undefined
      : bytes.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * A unique top-level `const REF = <literal>` in the bounded scan (src/
 * preferred, whole repo fallback). Comments/strings are never declarations.
 * Duplicate names, invalid source and computed initializers cannot decide —
 * a behavior implemented as computed logic is deliberately not guessed: the
 * caller keeps the plain row and its verify-against-code caveat instead.
 */
export function findConstant(dir: string, ref: string): CodeFact | null {
  const files: string[] = [];
  walk(join(dir, "src"), 0, files);
  if (!files.length) walk(dir, 0, files);
  if (files.length > MAX_FILES) return null;
  let fact: CodeFact | null = null;
  for (const f of files) {
    try {
      const text = readBounded(f);
      if (text === undefined) return null;
      if (!text.includes(ref) && !text.includes("\\u")) continue;
      const value = declaration(text, f, ref);
      if (value === null || (value !== undefined && fact)) return null;
      if (value !== undefined) fact = { file: relative(dir, f), value };
    } catch {
      // A relevant unreadable/invalid source is not evidence of absence.
      return null;
    }
  }
  return fact;
}

/**
 * Numeric-aware agreement: "$50.00" == "50", "0.0825" == "0.0825", and a
 * percent claim matches the fraction it names ("8.25%" == "0.0825"). String
 * whitespace is significant. Undefined means the claim cannot decide the
 * observed literal's value — the caller must keep plain guidance.
 */
export function valuesAgree(claim: string, code: string): boolean | undefined {
  try {
    const observed = literalValue(sourceParser().parseExpression(code));
    if (observed === undefined) return undefined;
    let stated = claim.trim();
    if (stated.startsWith('"') || stated.startsWith("'")) {
      const decoded = literalValue(sourceParser().parseExpression(stated));
      if (typeof decoded !== "string") return undefined;
      stated = decoded;
    }
    const numeric = (s: string): number | undefined => {
      if (
        !/^[+-]?\$?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i.test(
          s,
        )
      )
        return undefined;
      const [mantissa, exponent = "0"] = s.replace(/[$,%]/g, "").split(/e/i);
      // Shift before converting: dividing an already-rounded float (8.2/100)
      // invents a mismatch with the literal 0.082.
      const n = Number(
        `${mantissa}e${Number(exponent) - (s.endsWith("%") ? 2 : 0)}`,
      );
      return Number.isFinite(n) ? n : undefined;
    };
    const value = numeric(stated);
    if (typeof observed === "number")
      return value === undefined ? undefined : value === observed;
    if (typeof observed === "string") {
      const n = numeric(observed);
      return n !== undefined && value !== undefined
        ? n === value
        : stated === observed;
    }
    if (observed === null) return stated === "null" ? true : undefined;
    return stated === "true" || stated === "false"
      ? (stated === "true") === observed
      : undefined;
  } catch {
    return undefined;
  }
}

/** The one flagged object: both facts, the provenance, the FIXED verdict. */
export function conflictLine(m: Memory, fact: CodeFact): string {
  return (
    `CONFLICT (${m.ref}). Memory: ${m.claim} — user-stated, never verified. ` +
    `Code today: ${m.ref} = ${fact.value} (observed in ${fact.file}). ` +
    (m.klass === "spec"
      ? `Class: spec — the user is the authority on this value. Action: the code is the bug; fix ${m.ref} to ${m.claim}.`
      : `Class: behavior — working code is the authority. Action: trust the code; do not edit ${m.ref}; if the remembered rule looks intentional, raise it with the user instead.`)
  );
}
