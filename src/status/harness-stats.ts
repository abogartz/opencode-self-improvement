import { parseLine } from "../core/logfmt/format.ts";
import { recordedHarness } from "../telemetry/harness.ts";
import { captureCost, captureHealth, captureLag } from "./metrics.ts";

export interface UsageTotals {
  sessions: number;
  input: number;
  read: number;
  write: number;
  output: number;
  reasoning: number | null;
}
const TOKEN_FIELDS = ["input", "read", "write", "output", "reasoning"] as const;
type Entry = {
  line: string;
  fields: Record<string, unknown>;
  time: number;
  harness: string;
};

function entries(
  lines: readonly string[],
  cutoff: number,
  now: number,
): Entry[] {
  return lines.flatMap((line) => {
    const fields = parseLine(line);
    const time =
      fields && typeof fields.ts === "string" ? Date.parse(fields.ts) : NaN;
    return fields && Number.isFinite(time) && time >= cutoff && time <= now
      ? [{ line, fields, time, harness: recordedHarness(fields.harness) }]
      : [];
  });
}

function summarize(
  harness: string,
  evidence: Entry[],
  hits: Entry[],
  days: number,
  now: number,
) {
  const retrievals = { inject: 0, pull: 0, recall: 0 };
  for (const { fields } of hits) {
    if (fields.ev !== "memory_used") continue;
    if (
      fields.src === "inject" ||
      fields.src === "pull" ||
      fields.src === "recall"
    )
      retrievals[fields.src]++;
  }
  // Usage receipts are session totals, never deltas. Latest observation wins even
  // when asynchronous append order differs; two harnesses can use the same SID.
  const latest = new Map<
    string,
    { observed: number; tokens: Omit<UsageTotals, "sessions"> }
  >();
  for (const entry of evidence) {
    const f = entry.fields;
    if (f.ev !== "session_usage" || typeof f.session !== "string" || !f.session)
      continue;
    const values = TOKEN_FIELDS.map((key) =>
      typeof f[key] === "string" && String(f[key]).trim()
        ? Number(f[key])
        : NaN,
    );
    if (
      !values.every(
        (n, i) =>
          (TOKEN_FIELDS[i] === "reasoning" && f.reasoning === undefined) ||
          (Number.isFinite(n) && n >= 0),
      )
    )
      continue;
    const observed = f.observed === undefined ? entry.time : Number(f.observed);
    if (!Number.isFinite(observed) || observed < 0) continue;
    const key = `${entry.harness}\0${f.session}`;
    if ((latest.get(key)?.observed ?? -1) > observed) continue;
    const tokens = Object.fromEntries(
      TOKEN_FIELDS.map((key, i) => [
        key,
        key === "reasoning" && f.reasoning === undefined ? null : values[i]!,
      ]),
    ) as Omit<UsageTotals, "sessions">;
    latest.set(key, { observed, tokens });
  }
  const usage: UsageTotals | null = latest.size
    ? {
        sessions: latest.size,
        input: 0,
        read: 0,
        write: 0,
        output: 0,
        reasoning: 0,
      }
    : null;
  if (usage)
    for (const { tokens } of latest.values())
      for (const key of TOKEN_FIELDS) {
        if (key === "reasoning")
          usage.reasoning =
            usage.reasoning === null || tokens.reasoning === null
              ? null
              : usage.reasoning + tokens.reasoning;
        else usage[key] += tokens[key];
      }
  const lines = evidence.map((e) => e.line);
  return {
    harness,
    retrievals,
    usage,
    blockedWrites: evidence.filter((e) => e.fields.ev === "write_blocked")
      .length,
    capture: captureCost(lines, days, now),
    captureLag: captureLag(lines, days, now),
    captureHealth: captureHealth(lines, days, now),
  };
}

export type HarnessStats = ReturnType<typeof summarize>;
export interface HarnessActivity {
  days: number;
  since: string | null;
  total: HarnessStats;
  harnesses: HarnessStats[];
}

/** Counts only: no project names, session IDs, prompts or memory text are exposed. */
export function summarizeHarnessActivity(
  evidenceLines: readonly string[],
  hitLines: readonly string[],
  days = 30,
  now = Date.now(),
): HarnessActivity {
  const cutoff = now - days * 86_400_000;
  const evidence = entries(evidenceLines, cutoff, now);
  const hits = entries(hitLines, cutoff, now);
  const groups = new Set([...evidence, ...hits].map((e) => e.harness));
  let earliest: number | undefined;
  for (const e of [...evidence, ...hits])
    if (earliest === undefined || e.time < earliest) earliest = e.time;
  return {
    days,
    since: earliest === undefined ? null : new Date(earliest).toISOString(),
    total: summarize("all harnesses", evidence, hits, days, now),
    harnesses: [...groups].sort().map((name) =>
      summarize(
        name,
        evidence.filter((e) => e.harness === name),
        hits.filter((e) => e.harness === name),
        days,
        now,
      ),
    ),
  };
}

export function harnessActivityLines(activity: HarnessActivity): string[] {
  const lines = [
    "HARNESS ACTIVITY",
    `  store-wide retained telemetry, trailing ${activity.days}d; oldest observed record ${activity.since ?? "none"}`,
  ];
  for (const group of [activity.total, ...activity.harnesses]) {
    const r = group.retrievals;
    lines.push(
      `  ${group.harness}: credited retrievals inject ${r.inject} / pull ${r.pull} / recall ${r.recall}; blocked writes ${group.blockedWrites}`,
    );
    const u = group.usage;
    lines.push(
      u
        ? `    reported session tokens: input ${u.input} / cache-read ${u.read} / cache-write ${u.write} / output ${u.output} / reasoning ${u.reasoning ?? "not reported for every session"} (${u.sessions} session totals)`
        : "    reported session tokens: not reported",
    );
    lines.push(
      `    observed captures ${group.capture.calls}; ~${group.capture.estTokens} tokens estimated separately; captured rows ${group.captureHealth.rows}`,
    );
    if (group.harness !== "all harnesses")
      lines.push(
        `    latest capture configuration: ${group.captureHealth.state}`,
      );
    if (group.captureLag.n)
      lines.push(
        `    capture lag p50 ${group.captureLag.p50} ms / p95 ${group.captureLag.p95} ms (${group.captureLag.n} samples)`,
      );
  }
  lines.push(
    "  Retrieval credits are throttled; retained counts are floors, not lifetime totals. Session totals may include work before this window; unreported sessions are excluded.",
    "  Output includes reasoning where the host supplies no separate split; mixed totals cannot establish the answer/reasoning split.",
    "  Legacy records without a harness are OpenCode. New unattributed activity is unknown. Memory inventory and ownership remain shared.",
  );
  return lines;
}
