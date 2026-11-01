// decay — split from src/portable.ts (#168 domain restructure). Declaration bodies are unchanged.
import { open } from "node:fs/promises";
import { loadAll } from "../store/files/load.ts"
import { type Memory } from "../store/model/memory.ts"
import { isInjectable } from "../store/model/predicates.ts"
import { isVisibleTo, readerFromSid } from "../store/model/visibility.ts";

// --- decay support --------------------------------------------------------------

// Active open threads with ts older than `days` days, oldest first (both sides
// are UTC-Z ISO strings, so plain lexicographic compare is correct).
export async function findStaleOpen(days: number, sid?: string): Promise<Memory[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const reader = readerFromSid(sid);
  return (await loadAll())
    // Decay is repo-scoped: running it here must not retire
    // another repo's open threads.
    .filter((m) => isInjectable(m) && isVisibleTo(m, reader) && m.status === "open" && m.ts < cutoff)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
