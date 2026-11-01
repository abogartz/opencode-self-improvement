// Heuristic review queue for untrusted capture/import prose, not a guarantee
// against prompt injection. Matches are identifiers only; never audit the text.
export const QUARANTINE_TAG = "quarantine";
const PATTERNS: readonly [string, RegExp][] = [
  ["instruction_override", /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules|prompts)\b/i],
  ["role_header", /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?(?:system|developer|assistant)[ \t]*:/i],
  ["role_delimiter", /<\|(?:im_start|start_header_id)\|>|<\/?(?:system|developer|assistant)>|\[(?:system|developer|assistant)\]/i],
  ["download_execute", /\b(?:curl|wget)\b[^\r\n|]{0,2048}(?:\||&&)\s*(?:sh|bash|zsh|powershell|pwsh)\b/i],
  ["dynamic_execute", /(?<![$\w.])(?:eval|exec)\s*\(|\b(?:Invoke-Expression|iex)\s+/i],
];

export function quarantinePatterns(content: string): string[] {
  return PATTERNS.filter(([, pattern]) => pattern.test(content)).map(([id]) => id);
}

export function isQuarantined(row: { tags?: string[] }): boolean {
  return row.tags?.includes(QUARANTINE_TAG) === true;
}

export function quarantineReasons(row: { tags?: string[] }): string[] {
  return PATTERNS.map(([id]) => id).filter((id) => row.tags?.includes(`quarantine:${id}`));
}

export function quarantineCandidate<T extends { content: string; tags?: string[] }>(candidate: T): T {
  const hits = quarantinePatterns(candidate.content);
  if (!hits.length) return candidate;
  return {
    ...candidate,
    tags: [...new Set([...(candidate.tags ?? []), QUARANTINE_TAG, ...hits.map((id) => `quarantine:${id}`)])],
  };
}
