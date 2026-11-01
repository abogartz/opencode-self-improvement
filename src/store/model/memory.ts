// memory — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.

export type MemoryStatus = "open" | "settled";

// Hard ceiling on stored content. No entry point may persist a line longer
// than this: injection ever shows ~1200 chars, the gate runs on the shared
// service event loop, and regex scanning over megabyte-scale strings froze
// sessions (100KB write = 6s, 2MB = hang).
// Enforced twice — politely in runWriteGate (blocked outcome + evidence),
// absolutely in appendMemory (throws, covering gate-bypassing callers).
export const MAX_CONTENT_CHARS = 4000;

/** How many retrieval keywords a row may carry, and how long each one may be. */
export const MAX_KEYWORDS = 8;

export const MAX_KEYWORD_CHARS = 48;

/**
 * Normalise author-supplied retrieval keywords: trim, lowercase, split on the
 * storage delimiter, de-duplicate, drop empties and over-long entries, cap the
 * count. TOTAL on purpose — junk yields a shorter list rather than a throw,
 * because keywords only ever widen recall and must never be able to fail a
 * write the prose alone deserved.
 */
export function normalizeKeywords(kw: unknown): string[] | undefined {
  if (!Array.isArray(kw)) return undefined;
  const out: string[] = [];
  for (const item of kw) {
    if (typeof item !== "string") continue;
    // Commas are the storage delimiter (kw serialises as one comma-joined
    // scalar), so an item carrying one would read back fragmented. Treat them
    // as separators: "build, test" becomes two aliases, never a " test".
    for (const part of item.split(",")) {
      const k = part.trim().toLowerCase();
      if (!k || k.length > MAX_KEYWORD_CHARS) continue;
      if (!out.includes(k)) out.push(k);
      if (out.length === MAX_KEYWORDS) break;
    }
    if (out.length === MAX_KEYWORDS) break;
  }
  return out.length ? out : undefined;
}

export interface Memory {
  ts: string;
  type: string;
  scope: string;
  content: string;
  issue?: string;
  tags?: string[];
  // Retrieval keywords (#40): author-supplied aliases, verb forms and synonyms
  // for this row, written at capture time. They widen the scoring haystack
  // ONLY — a row is never rendered through them, so injection bytes and the
  // content cap stay exactly what the prose says. This is the zero-embedding
  // answer to the bench's strict-paraphrase wall (0% R@1: the user's words are
  // not the memory's words).
  kw?: string[];
  superseded_by?: string;
  reason?: string;
  status?: MemoryStatus;
  // Origin repo: sha1 of the normalized origin URL, the toplevel
  // path when the repo had no remote, the literal "global" for cross-project
  // writes, or absent for legacy/viewer rows — all three read as described
  // in isVisibleHere().
  repo?: string;
  repoPath?: string;
  file: string;
  index: number;
}

// Row identity is `ts`: supersede chains, the blocklist, undo matching, and
// the viewer's action buttons all key off it. A row whose ts is
// not an ISO instant must never become an addressable live row — readers
// treat it as malformed: skipped, counted, warned once per file. The shape
// check lives here (the store knows its schema); logfmt stays a dumb parser.
export const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const malformedWarnedFiles = new Set<string>();

// Score one row against a query: exact row id first, then content.
export function targetScore(m: Memory, query: string): number {
  const ts = m.ts.toLowerCase();
  if (ts === query) return 100;
  // A clock fragment ("00:11:25.867") is unique enough to identify a row.
  if (query.length >= 8 && ts.includes(query)) return 95;
  const content = m.content.toLowerCase();
  if (content === query) return 90;
  if (content.includes(query)) return 80;
  if (query.includes(content)) return 70;
  return 0;
}
