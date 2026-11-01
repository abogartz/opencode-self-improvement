// The memory_status tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { neverRetrieved, readLedger } from "../hits.ts";
import { formatMemory } from "../inject.ts";
import { isActive, isVisibleTo, loadAll, malformedCount, readerFromSid } from "../memory.ts";
import { isQuarantined, quarantineReasons } from "../quarantine.ts";
import { EmptyArgs, validated } from "../schema.ts";
import { blockedRecent, captureLag, captureLagLines, renderMemoryReport, rowsPerDay } from "../status.ts";
import type { StoreCounts } from "../status.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, sessions, direct } = deps;
    editor.add(validated(EmptyArgs, {
      name: "memory_status",
      description:
        "Plain-text memory report for chat clients (desktop/web/IDE), same sections as the terminal /memory panel: CONTEXT (this session's injected block, budget use, cumulative ride and abstentions), CACHE (plain-language cache receipts: bust count, and the provider-reported share of prompt tokens served from cache — the proof that memory never mutates your prefix), the block verbatim, recent blocked writes with gate reasons, and store stats. Reads only — no model call.",
      options: direct,
      async execute(_args, context): Promise<{ content: string }> {
        // In-process truth: the live epoch + ledger, fresher than any file.
        const sid = toolIds(context).sid;
        const reportReader = readerFromSid(sid);
        if (sid !== "?") await sessions.refresh(sid);
        const status = sid === "?" ? null : await sessions.buildPayload(sid);
        const all = await loadAll();
        const act = all.filter(isActive);
        const store: StoreCounts = {
          active: act.length,
          superseded: all.length - act.length,
          open: act.filter((m) => m.status === "open").length,
          scopes: new Set(act.map((m) => m.scope)).size,
          malformed: malformedCount(),
        };
        // Use ledger (#42): how much of the store has never been surfaced.
        // Reported, never acted on — retirement is a decision, not a metric.
        const ledger = await readLedger();
        store.neverRetrieved = neverRetrieved(act, ledger).length;
        store.ledgerSince = ledger.since;
        // Self-metrics (#44): what the store costs, how fast it grows, and how
        // stale a capture is when it fires. Same rule as above — the numbers
        // are the point, not a verdict on them.
        store.bytes = act.reduce((n, m) => n + new TextEncoder().encode(formatMemory(m)).length, 0);
        store.bytesPerRow = act.length ? Math.round(store.bytes / act.length) : 0;
        store.rowsPerDay = rowsPerDay(act) ?? undefined;
        store.captureLag = captureLag(await captureLagLines());
        return {
          content: renderMemoryReport({ status, store, blocked: await blockedRecent(6),
            quarantined: act.filter((m) => isVisibleTo(m, reportReader) && isQuarantined(m))
              .map((m) => ({ ts: m.ts, patterns: quarantineReasons(m) })),
          }),
        };
      },
    }));
};
