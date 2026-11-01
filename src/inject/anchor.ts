// anchor — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
import { loadAll } from "../store/files/load.ts"
import { type Memory } from "../store/model/memory.ts"
import { isInjectable } from "../store/model/predicates.ts"
import { readerFromSid, visibleTo } from "../store/model/visibility.ts";
import { cmpTs } from "../core/cmp-ts.ts";
import { FRAME, capToBudget } from "./budget.ts";
import { formatMemory } from "./format.ts";

// Memory-aware compaction: a durable-memory block pushed onto the
// V2 compaction hook's `system` parts, where the summarizer model can see it
// (OpenCode appends its own summary prompt AFTER hooks). Deterministic, zero
// extra model calls; fixes "compaction amnesia". Composition: up to 10 open
// threads newest-first, then up to 5 newest settled memories, total rows
// capped by `limit`; the whole block capped at 2500 chars at whole-line
// boundaries. "" when the store has no active memories.
const ANCHOR_OPEN_LIMIT = 10;

const ANCHOR_SETTLED_LIMIT = 5;

const ANCHOR_BUDGET = 2500;

export async function compactionAnchor(limit = 12, sid?: string): Promise<string> {
  // Repo-scoped: model-facing reads see the caller's repo + global rows.
  const mems = visibleTo((await loadAll()).filter(isInjectable), readerFromSid(sid));
  if (!mems.length) return "";
  const byNewest = (a: Memory, b: Memory) => cmpTs(b.ts, a.ts);
  const open = mems
    .filter((m) => m.status === "open")
    .sort(byNewest)
    .slice(0, Math.min(ANCHOR_OPEN_LIMIT, Math.max(0, limit)));
  const settled = mems
    .filter((m) => m.status !== "open")
    .sort(byNewest)
    .slice(0, Math.min(ANCHOR_SETTLED_LIMIT, Math.max(0, limit - open.length)));
  const rows = [...open, ...settled];
  if (!rows.length) return "";
  const block =
    `## Durable memory to preserve in this summary${FRAME}\n` +
    "Preserve these facts verbatim (dates, commands, ids) in the compaction summary:\n" +
    rows.map(formatMemory).join("\n");
  return capToBudget(block, ANCHOR_BUDGET);
}
