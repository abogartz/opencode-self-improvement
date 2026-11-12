// The memory_status tool, extracted from index.ts (#168).
// Closure access arrives through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { readLedger } from "../hits/ledger.ts";
import { formatMemory } from "../inject/format.ts";
import { loadAll, malformedCount } from "../store/files/load.ts";
import { isVisibleTo, readerFromSid } from "../store/model/visibility.ts";
import {
  isQuarantined,
  quarantineReasons,
} from "../store/quarantine/quarantine.ts";
import { EmptyArgs, validated } from "./schema.ts";
import {
  captureHealth,
  captureCost,
  captureLag,
  captureLagLines,
  rowsPerDay,
} from "../status/metrics.ts";
import { renderMemoryReport } from "../status/report.ts";
import { blockedRecent } from "../status/write.ts";
import { summarizeStore } from "../status/store-summary.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, sessions, direct } = deps;
  editor.add(
    validated(EmptyArgs, {
      name: "memory_status",
      description:
        "Plain-text memory report for chat clients (desktop/web/IDE), same sections as the terminal /memory panel: CONTEXT (this session's injected block, budget use, cumulative ride and abstentions), CACHE (epochs whose bytes moved, plus provider-reported cache receipts; byte changes are not a cache-miss estimate), the block verbatim, recent blocked writes with gate reasons (filtered to this reader's evidence visibility, #306), and store stats. Aggregate STORE counts are machine-wide — they count every repository's rows by decision (#213 B), not this reader's. Reads only — no model call.",
      options: direct,
      async execute(_args, context): Promise<{ content: string }> {
        // In-process truth: the live epoch + ledger, fresher than any file.
        const sid = toolIds(context).sid;
        const reportReader = readerFromSid(sid);
        if (sid !== "?") await sessions.refresh(sid);
        const status = sid === "?" ? null : await sessions.buildPayload(sid);
        const all = await loadAll();
        const malformed = malformedCount();
        // Use ledger (#42): how much of the store has never been surfaced.
        // Reported, never acted on — retirement is a decision, not a metric.
        const ledger = await readLedger();
        const { active: act, counts: store } = summarizeStore(
          all,
          ledger,
          malformed,
        );
        // Self-metrics (#44): what the store costs, how fast it grows, and how
        // stale a capture is when it fires. Same rule as above — the numbers
        // are the point, not a verdict on them.
        store.bytes = act.reduce(
          (n, m) => n + new TextEncoder().encode(formatMemory(m)).length,
          0,
        );
        store.bytesPerRow = act.length
          ? Math.round(store.bytes / act.length)
          : 0;
        store.rowsPerDay = rowsPerDay(act) ?? undefined;
        const evidenceLines = await captureLagLines();
        store.captureLag = captureLag(evidenceLines);
        // #387: the plugin's own model calls, billed. Same evidence read, so
        // the number cannot disagree with the lag line above it.
        store.captureCost = captureCost(evidenceLines);
        return {
          content: renderMemoryReport({
            status,
            store,
            blocked: await blockedRecent(6, reportReader, sid),
            quarantined: act
              .filter((m) => isVisibleTo(m, reportReader) && isQuarantined(m))
              .map((m) => ({ ts: m.ts, patterns: quarantineReasons(m) })),
            // #138: capture state read from the same evidence window, so the
            // chat surface distinguishes off / misconfigured / inert / alive.
            capture: captureHealth(evidenceLines),
          }),
        };
      },
    }),
  );
};
