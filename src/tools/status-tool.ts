// The memory_status tool, extracted from index.ts.
// Closure access arrives through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import {
  getDroppedOutcomeWrites,
  readLedger,
  readOutcomes,
  readRides,
} from "../telemetry/ledger.ts";
import { formatMemory } from "../inject/format.ts";
import { loadAll, malformedCount } from "../store/files/load.ts";
import {
  isVisibleTo,
  readerForSession,
  readerFromSid,
} from "../store/model/visibility.ts";
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
import { droppedEvidenceWrites } from "../telemetry/record.ts";
import { hitsFile } from "../telemetry/ledger.ts";
import { readLines } from "../core/logfmt/read.ts";
import { summarizeHarnessActivity } from "../status/harness-stats.ts";
import { currentHarness } from "../telemetry/harness.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, sessions } = deps;
  editor.add(
    validated(EmptyArgs, {
      name: "memory_status",
      description:
        "Read-only memory report: CONTEXT (this session's injected block, budget use, cumulative ride and abstentions), CACHE (changed epochs and provider-reported cache receipts; byte changes are not a cache-miss estimate), the block verbatim, recent blocked writes visible to this reader, STORE stats, and HARNESS ACTIVITY (combined and per-harness retrievals, reported session tokens, and capture estimates). Aggregate counts cover the shared store across repositories; memory ownership stays project/global. No model call.",
      async execute(_args, context): Promise<{ content: string }> {
        // In-process truth: the live epoch + ledger, fresher than any file.
        const sid = toolIds(context).sid;
        const detailReader = readerForSession(sid);
        const reportReader = readerFromSid(sid);
        if (sid !== "?") await sessions.refresh(sid);
        const status = sid === "?" ? null : await sessions.buildPayload(sid);
        const all = await loadAll();
        const malformed = malformedCount();
        // Use ledger: how much of the store has never been surfaced.
        // Reported, never acted on — retirement is a decision, not a metric.
        const ledger = await readLedger();
        // rides joined to the gate outcome of the turn they rode. Read
        // only here — the epoch payload path deliberately skips it, so the
        // per-request path never pays two extra ledger reads.
        const { active: act, counts: store } = summarizeStore(
          all,
          ledger,
          malformed,
          {
            rides: await readRides(),
            outcomes: await readOutcomes(),
            droppedOutcomeWrites: getDroppedOutcomeWrites(),
            visible: (row) => isVisibleTo(row, detailReader),
          },
        );
        // Self-metrics: what the store costs, how fast it grows, and how
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
        // the plugin's own model calls, billed. Same evidence read, so
        // the number cannot disagree with the lag line above it.
        store.captureCost = captureCost(evidenceLines);
        const harnessActivity = summarizeHarnessActivity(
          evidenceLines,
          await readLines(hitsFile()),
        );
        const harness = currentHarness();
        return {
          content: renderMemoryReport({
            status,
            harnessActivity,
            store,
            blocked: await blockedRecent(6, reportReader, sid),
            quarantined: act
              .filter((m) => isVisibleTo(m, reportReader) && isQuarantined(m))
              .map((m) => ({ ts: m.ts, patterns: quarantineReasons(m) })),
            // capture state read from the same evidence window, so the
            // chat surface distinguishes off / misconfigured / inert / alive.
            captureHarness: harness,
            capture:
              harnessActivity.harnesses.find(
                (group) => group.harness === harness,
              )?.captureHealth ?? captureHealth([]),
            // Lost evidence writes cannot report themselves through the log, so
            // this one number comes from this process instead.
            evidence: droppedEvidenceWrites(),
          }),
        };
      },
    }),
  );
};
