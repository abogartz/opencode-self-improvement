// digest — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
import { loadAll } from "../store/files/load.ts"
import { type Memory } from "../store/model/memory.ts"
import { isInjectable } from "../store/model/predicates.ts"
import { readerFromSid, visibleTo } from "../store/model/visibility.ts";
import { record } from "../evidence/record.ts";
import { frontierBudget } from "../core/config/budgets.ts"
import { dateStr } from "../core/time.ts";
import { bracketList } from "../core/logfmt/format.ts";
import { recentConvergenceSummary } from "../capture/triggers.ts";
import { flattenMemoryText } from "../store/sanitize.ts";
import { cmpTs } from "../core/cmp-ts.ts";
import { cappedFrontier } from "./budget.ts";
import { type TransformOutput } from "./pull.ts";

// Only the newest open threads are surfaced, and each session sees the block
// once (per process). Rows can be long (up to the content cap), so the block is
// also held to its own frontierBudget, with any omission shown in the block.
const OPEN_THREAD_LIMIT = 3;

const frontierInjectedSessions = new Set<string>();

export interface DigestOptions {
  // Rows the caller already loaded for this request (shared with the epoch).
  rows?: Memory[];
  frontierBudget?: number;
}

export async function systemDigest(
  _input: unknown,
  output: TransformOutput,
  opts: DigestOptions = {},
): Promise<void> {
  const sid =
    typeof _input === "object" && _input !== null &&
    "sessionID" in _input &&
    typeof (_input as Record<string, unknown>).sessionID === "string"
      ? String((_input as Record<string, unknown>).sessionID)
      : "?";
  // Repo-scoped: model-facing reads see the CALLER's repo + global rows, via
  // the sid carried on this flow's input (#127) — never a global re-read
  // after the loadAll await.
  const mems = (opts.rows ?? visibleTo(await loadAll(), readerFromSid(sid))).filter(isInjectable);
  if (!mems.length) return;
  // CACHE-STABLE BY CONSTRUCTION (issue #162): this line carries no row count
  // and no latest-ts. Both change on every promoted write, and the digest rides
  // the FRONT of the system prompt, so one volatile byte invalidated the whole
  // cached prefix — every memory write cost the next request a full re-prefill.
  // The exact numbers belong on surfaces where they are free and never ride a
  // prompt: the footer badge, /memory, memory_status, the viewer.
  output.system.push(
    "\n## Persistent memory (opencode-self-improvement)\n" +
      "Durable memories exist for this repository. Check memory_recall BEFORE grepping or " +
      "reading, for build/test/lint commands, decisions, and conventions. Relevant memories " +
      "are also auto-injected when your message matches.",
  );

  const open = mems
    .filter((m) => m.status === "open")
    .sort((a, b) => cmpTs(b.ts, a.ts))
    .slice(0, OPEN_THREAD_LIMIT);
  if (!open.length) return;

  const frontier = cappedFrontier(open, opts.frontierBudget ?? frontierBudget());
  output.system.push(`\n${frontier.block}`);

  // Aggregate of past sessions' convergence (one line, gated on data existing;
  // I3: it is a derived fact, never the raw log). Gives the next session the
  // signal to recall-first and stop re-deriving.
  const conv = await recentConvergenceSummary();
  if (conv) output.system.push(`\nConvergence tracking: ${conv}`);

  if (frontierInjectedSessions.has(sid)) return;
  frontierInjectedSessions.add(sid);
  const openMems = mems.filter((m) => m.status === "open");
  await record(
    "frontier_injected",
    {
      session: sid,
      scopes: bracketList([...new Set(frontier.shown.map((m) => flattenMemoryText(m.scope)))]),
      shown: frontier.shown.length,
      omitted: frontier.omitted,
      ...(frontier.omitted ? { reason: "over_budget" } : {}),
      open_total: openMems.length,
      ts_since: dateStr(),
    },
    false,
  );
}
