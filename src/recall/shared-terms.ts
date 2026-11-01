// shared-terms — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
import { type Memory } from "../store/model/memory.ts";
import { QUERY_STOPWORDS, haystack, words } from "./score.ts";

export function sharedTerms(query: string, m: Memory, cap = 8): string[] {
  const q = new Set(words(query).filter((t) => !QUERY_STOPWORDS.has(t)));
  if (!q.size) return [];
  const hay = new Set(words(haystack(m)));
  const out: string[] = [];
  for (const t of q) {
    if (hay.has(t) && !out.includes(t)) out.push(t);
    if (out.length === cap) break;
  }
  return out;
}
