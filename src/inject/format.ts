// format — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
import { type Memory } from "../store/model/memory.ts";
import { flattenMemoryText } from "../store/sanitize.ts";
import { capToBudget } from "./budget.ts";

function dateOf(ts: string): string {
  return ts.split("T")[0];
}

// Provenance tags marking rows that entered through a path the write gate
// cannot fully vouch for: memory_import of a shared file and auto-capture
// mined from transcripts (which may contain fetched web pages). Surfaced in
// every injected row so the model — and the user reading the panel or list —
// can discount unverified content. Only these known tags render; arbitrary
// user tags never enter the injected line (they would be their own injection
// surface).
const PROVENANCE_TAGS = ["auto-capture", "import"] as const;

export function formatMemory(m: Memory): string {
  const tag = m.status === "open" ? " [open]" : "";
  const via = PROVENANCE_TAGS.filter((t) => m.tags?.includes(t));
  const src = via.length ? ` [via ${via.join("+")}]` : "";
  // One memory is ONE line in every injected block: the store round-trips real
  // newlines, so a planted "\n## Fake header" would forge its own section and
  // escape the framing (and throw capToBudget's line accounting off). Line
  // breaks and other controls collapse to spaces; ordinary spacing survives.
  const date = flattenMemoryText(dateOf(m.ts));
  const type = flattenMemoryText(m.type);
  const scope = flattenMemoryText(m.scope);
  const content = flattenMemoryText(m.content);
  return `- [${date}]${tag}${src} ${type}/${scope}: ${content}`;
}
