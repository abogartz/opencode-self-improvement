// candidates — split from src/capture.ts (#168 domain restructure). Declaration bodies are unchanged.
// Opt-in auto-capture parsing, prompt, and lag helpers. Host access and model
// calls live in src/index.ts. Every candidate that leaves this module flows
// through runWriteGate in index.ts: capture NEVER writes memories directly,
// so dupes/stale/canonical rules keep the moat (same as model-authored writes).
// All parsing functions are TOTAL: any malformed input yields [] / "" / null,
// never a throw.
import { TYPES } from "../core/types.ts";
import { flattenMemoryText } from "../store/sanitize.ts";
import { CAPTURE_KEYWORD_CAP, CAPTURE_KEYWORD_CHARS, type CaptureCandidate } from "./prompt.ts";

function cleanKeywords(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const k = item.trim().toLowerCase();
    if (!k || k.length > CAPTURE_KEYWORD_CHARS || flattenMemoryText(k) !== k) continue;
    if (!out.includes(k)) out.push(k);
    if (out.length === CAPTURE_KEYWORD_CAP) break;
  }
  return out.length ? out : undefined;
}

const VALID_TYPES = new Set<string>(TYPES);

// Remove markdown code-fence marker lines, keeping the fenced payload.
function stripFences(text: string): string {
  return text.replace(/^[ \t]*```[^\n]*$/gm, "");
}

// First balanced [...] span, string-literal aware. null when absent or
// unbalanced (a model that truncates mid-array yields nothing, not garbage).
function firstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Extract memory candidates from a model reply. Never throws: any malformed
// input yields []. Items missing fields, with unknown types, or with content
// outside 20-600 chars are dropped; the result is clamped to `max`.
export function parseCandidates(raw: string, max: number): CaptureCandidate[] {
  try {
    if (typeof raw !== "string" || !raw.trim() || !(max > 0)) return [];
    const span = firstJsonArray(stripFences(raw));
    if (!span) return [];
    const parsed = JSON.parse(span);
    if (!Array.isArray(parsed)) return [];
    const out: CaptureCandidate[] = [];
    for (const item of parsed) {
      if (out.length >= max) break;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const o = item as Record<string, unknown>;
      const rawType = typeof o.type === "string" ? o.type : "";
      const rawScope = typeof o.scope === "string" ? o.scope : "";
      const type = rawType.trim();
      const scope = rawScope.trim();
      const content = typeof o.content === "string" ? o.content.trim() : "";
      if (!type || !scope || !content) continue;
      if (
        flattenMemoryText(rawType) !== rawType ||
        flattenMemoryText(rawScope) !== rawScope
      ) continue;
      if (!VALID_TYPES.has(type)) continue;
      if (content.length < 20 || content.length > 600) continue;
      const status = o.status === "open" || o.status === "settled" ? o.status : undefined;
      // A bad kw list costs the row its keywords, never the row itself.
      const kw = cleanKeywords(o.kw);
      out.push({
        ...(status ? { type, scope, content, status } : { type, scope, content }),
        ...(kw ? { kw } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

// "provider/id" -> { providerID, id }, splitting on the FIRST "/". Returns
// null when the string has no slash or either half is empty — the caller then
// skips capture entirely rather than guessing a model.
export function parseModelRef(ref: unknown): { providerID: string; id: string } | null {
  if (typeof ref !== "string") return null;
  const i = ref.indexOf("/");
  if (i <= 0) return null;
  const providerID = ref.slice(0, i).trim();
  const id = ref.slice(i + 1).trim();
  if (!providerID || !id) return null;
  return { providerID, id };
}
