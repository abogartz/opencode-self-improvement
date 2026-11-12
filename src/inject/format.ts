// format — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
import { type Memory } from "../store/model/memory.ts";
import { provenanceMarker, provenanceOf } from "../store/model/provenance.ts";
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
  // #393: the discount the reader needs. `[via auto-capture]` says where a row
  // came from; this says whether anything OUTSIDE that source ever agreed with
  // it. R4 measured the cost of not saying so: one plausible wrong row shipped a
  // wrong artifact in 4/5 runs with no uncertainty flagged, while an empty store
  // declined to invent a value at all. Rendered as a separate token so the
  // existing `[via …]` contract is untouched.
  const trust = provenanceMarker(provenanceOf(m.tags));
  // One memory is ONE line in every injected block: the store round-trips real
  // newlines, so a planted "\n## Fake header" would forge its own section and
  // escape the framing (and throw capToBudget's line accounting off). Line
  // breaks and other controls collapse to spaces; ordinary spacing survives.
  const date = flattenMemoryText(dateOf(m.ts));
  const type = flattenMemoryText(m.type);
  const scope = flattenMemoryText(m.scope);
  const content = flattenMemoryText(m.content);
  // Verbatim user utterance (mystery 2): rendered so the user's exact words
  // reach the next session's request bytes even when the distilled content
  // paraphrases them. Stored after a substring check, so this is quotation,
  // not generation.
  const quote = m.original
    ? ` (user said: "${flattenMemoryText(m.original)}")`
    : "";
  return `- [${date}]${tag}${src}${trust} ${type}/${scope}: ${content}${quote}`;
}
