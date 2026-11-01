// relevant — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
import { loadAll } from "../store/files/load.ts"
import { type Memory } from "../store/model/memory.ts"
import { isInjectable } from "../store/model/predicates.ts"
import { readerFromSid, visibleTo } from "../store/model/visibility.ts";
import { FRAME } from "../inject/budget.ts";
import { formatMemory } from "../inject/format.ts";
import { scoreMemories } from "./score.ts";

export function argText(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["pattern", "query", "path", "filePath", "command"]) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/**
 * The content concepts a query and a row actually share (stopwords dropped,
 * capped, `ts` never included). This is what the use ledger records (#42):
 * every term in it already exists inside the row, so a hit line reveals
 * nothing about the prompt beyond the memory it points at — and it is enough
 * for #45 to replay a merge and prove the same reads would still land.
 */
/** The text a contextual pull actually searched with, for hit bookkeeping. */
export function pullQuery(args: unknown): string {
  return argText(args);
}

// Reinforcement (#42): a row the ledger has seen used breaks a tie over a row
// nobody ever read, and the more recently used one breaks it first. A TIE-BREAK
// only — the two-concept gate and IDF score still decide relevance, because
// popularity is not truth: reinforcement without evidence just amplifies
// whatever was retrieved first.
export interface UseSignals {
  get(ts: string): { count: number; last: string } | undefined;
}

export function useBoost(a: Memory | undefined, use?: UseSignals): number {
  if (!use || !a) return 0;
  return use.get(a.ts) ? 1 : 0;
}

// Select the rows relevant to a prompt and render the injection block, AND
// return the rows themselves so attribution (src/attribution.ts) can join the
// injected facts against the session's later tool calls. `relevantKnowledge`
// keeps its string contract for every existing caller; this is the richer seam.
export async function selectRelevant(
  message: string,
  limit = 3,
  rows?: Memory[],
  use?: UseSignals,
  sid?: string,
): Promise<{ block: string; selected: Memory[] }> {
  const text = message.trim();
  if (!text) return { block: "", selected: [] };
  // Repo-scoped: model-facing reads see the caller's repo + global rows
  // (their session when one was threaded, #127).
  const mems = (rows ?? visibleTo(await loadAll(), readerFromSid(sid))).filter(isInjectable);
  const top = scoreMemories(text, mems, limit, use);
  if (!top.length) return { block: "", selected: [] };
  return {
    block: `## Relevant durable memory${FRAME}\n${top.map(formatMemory).join("\n")}`,
    selected: top,
  };
}

export async function relevantKnowledge(message: string, limit = 3, rows?: Memory[]): Promise<string> {
  return (await selectRelevant(message, limit, rows)).block;
}
