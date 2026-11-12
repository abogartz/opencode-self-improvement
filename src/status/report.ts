// report — split from src/status.ts (#168 domain restructure). Declaration bodies are unchanged.
import { join } from "node:path";
import { cacheRate, estTok, fmtBytes, fmtCount, fmtMs } from "./format.ts";
import {
  type CaptureHealth,
  captureLag,
  ledgerIsYoung,
  rowsPerDay,
} from "./metrics.ts";
import {
  type BlockedRow,
  type StatusPayload,
  type StoreCounts,
  emptyStats,
} from "./payload.ts";

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function contextLines(p: StatusPayload): string[] {
  const st = p.stats ?? emptyStats();
  const pct = p.budget > 0 ? Math.round((p.blockChars / p.budget) * 100) : 0;
  return [
    `  injected now   ${p.blockChars}c ≈ ${estTok(p.blockChars)} tok · ${pct}% of ${p.budget}c budget`,
    // The budget caps the RELEVANCE BLOCK; the standing digest and the frontier
    // ride the system prompt too. Quoting only the budgeted slice would
    // understate what the request actually carries.
    ...(p.sectionChars === undefined
      ? []
      : [
          `  memory section ${p.sectionChars}c ≈ ${estTok(p.sectionChars)} tok riding the prompt` +
            ` (digest + frontier + the ${p.blockChars}c block above)`,
        ]),
    `  this epoch     ${p.reason} epoch since ${p.at} (${ago(p.at)}) · rode ${st.epochRequests} request(s)`,
    `  session        ${st.requests} request(s) · ${fmtCount(st.cumChars)}c ≈ ${fmtCount(estTok(st.cumChars))} tok rode · abstained ${st.abstained}`,
  ];
}

export function cacheLines(p: StatusPayload): string[] {
  const st = p.stats ?? emptyStats();
  const inv =
    st.invalidations === 0
      ? [
          "  epochs whose bytes moved  0 — memory-section bytes have not moved this session",
        ]
      : [
          `  epochs whose bytes moved  ${st.invalidations} this session · last ${
            st.lastInvalidation
              ? `${st.lastInvalidation.at.slice(11, 19)} (${st.lastInvalidation.reason})`
              : "-"
          }`,
          "                 counts memory-section byte changes, not provider cache misses",
        ];
  const rate = cacheRate(p.measured);
  const receipts = rate
    ? [
        `  receipts       ${fmtCount(rate.read)}/${fmtCount(rate.prompt)} prompt tok served from cache (${rate.pct}%)`,
        rate.pct >= 90
          ? "                 — observed session-wide cache reuse; memory-only cost is not measured"
          : "                 — lower observed reuse; this receipt does not identify the cause",
      ]
    : [
        "  receipts       provider reports no cache usage yet — byte history only:",
        `                 the block rode ${st.epochRequests} request(s) with ${st.invalidations} byte-moving epochs`,
      ];
  return [
    ...inv,
    ...receipts,
    `  recomputes     ${p.recomputes} block builds since server start (all sessions)`,
  ];
}

/**
 * CONTEXT WINDOW — the "is memory bloating my context?" answer, built ONLY from
 * numbers we trust: the exact injected block (we wrote those bytes), the
 * provider's own cache receipts, and the memory byte-change count. No estimated
 * decomposition of the system prompt or history (we cannot measure those); the
 * one honest share we can state is memory as a slice of what was actually sent.
 */
export function windowLines(p: StatusPayload): string[] {
  const memTok = estTok(p.blockChars);
  const pct = p.budget > 0 ? Math.round((p.blockChars / p.budget) * 100) : 0;
  const out: string[] = [
    `  memory slice   ${p.blockChars}c ≈ ${memTok} tok · ${pct}% of the ${p.budget}c inject budget (hard-capped by design)`,
  ];
  const m = p.measured;
  const used = m ? (m.input || 0) + (m.read || 0) + (m.write || 0) : 0;
  if (used > 0) {
    const share = Math.round((memTok / used) * 1000) / 10;
    const rate = cacheRate(m);
    out.push(
      `  of what you sent  ≈ ${fmtCount(used)} prompt tok · memory is ${share}% of it`,
    );
    out.push(
      rate
        ? `  cache served     ${rate.pct}% of that prompt from cache — provider-reported share, not a memory-only cost estimate`
        : "  cache served     provider has not reported a split yet",
    );
  } else {
    out.push(
      "  of what you sent  not measured yet — receipts appear after the first assistant turn",
    );
  }
  // #387: the completion side. Everything above counts the prompt only, and
  // `input` is the UNCACHED remainder, so neither was ever "what the session
  // cost" — the tokens the model produced were not reported at all. Rendered
  // only when the host reports them: an absent number stays absent rather than
  // showing 0, which reads as "generated nothing".
  const gen = m ? (m.output ?? 0) + (m.reasoning ?? 0) : 0;
  if (gen > 0) {
    out.push(
      `  what it produced  ${fmtCount(gen)} completion tok — ${fmtCount(m?.output ?? 0)} answer + ${fmtCount(m?.reasoning ?? 0)} reasoning (provider-reported, session-wide)`,
    );
  }
  const moved = p.stats?.invalidations ?? 0;
  out.push(
    `  epochs whose bytes moved  ${moved} this session${moved ? "" : " — memory-section bytes have not moved"}`,
  );
  return out;
}

/**
 * MEMORY ATTRIBUTION — which answers came from memory instead of re-reading
 * files. Every line is labeled [measured] (an observed tool-call fact) or
 * [inferred] (a coverage statement). Misses are shown alongside saves so the
 * panel reads as an audit, not marketing.
 */
export function attributionLines(p: StatusPayload): string[] {
  const a = p.attribution;
  if (!a) return ["  not computed — no memory was injected this session"];
  if (a.pathsCited === 0 && a.commandsMatched === 0 && a.readsTotal === 0) {
    return [
      "  the injected memory cited no file paths or commands yet — nothing to attribute",
    ];
  }
  return [
    `  Tier A · commands   ${a.commandSaves} lookup(s) avoided [measured] · ran a remembered command with no prior file lookup`,
    `  Tier B · coverage   cited ${a.pathsCited} · re-read ${a.pathsReRead} [measured] · not opened ${a.pathsSkipped} [inferred]`,
    `  new work            ${a.readsNotCovered}/${a.readsTotal} file lookups had no memory coverage [measured]`,
  ];
}

/**
 * AUTO-CAPTURE line (#138): the chat-facing answer to "is capture off,
 * misconfigured, armed-but-inert, or alive?" — the states the evidence file
 * distinguishes, surfaced so a user never has to read a logfmt file to learn
 * the pipeline never ran. `unknown` means no heartbeat was found at all, which
 * is itself the answer the dead-pipeline bug needed.
 */
export function captureLines(c: CaptureHealth): string[] {
  switch (c.state) {
    case "off":
      return ["  auto-capture: off (default)"];
    case "invalid_model":
      return [
        "  auto-capture: invalid_model — autoCapture is on but captureModel is malformed; nothing fires",
      ];
    case "no_capabilities":
      return [
        "  auto-capture: no_capabilities — autoCapture is on but the host lacks event.subscribe/generate.text/session.context",
      ];
    case "switch_mismatch":
      return [
        "  auto-capture: switch_mismatch — captureOnCompact is on but autoCapture is off; nothing fires",
      ];
    case "on": {
      // Inert means NO execution evidence at all: no candidate line and no
      // `capture_lag` completion receipt. A successful capture whose model
      // returned `[]` writes only the receipt, and is alive, not inert
      // (#288 F1).
      if (!c.lastExecuted && c.rows === 0 && c.blocked === 0)
        return [
          "  auto-capture: ARMED BUT NEVER FIRED — capture is on, no auto_capture_* or capture_lag lines in the last 30d",
        ];
      const fired = c.lastFired ?? c.lastExecuted;
      return [
        `  auto-capture: on, last fired ${fired ? ago(fired) : "now"}, ${c.rows} rows, ${c.blocked} refused`,
      ];
    }
    default:
      return [
        "  auto-capture: unknown — no plugin_load heartbeat in the evidence files (plugin never loaded here?)",
      ];
  }
}

/**
 * Plain-text rendering shared by the memory_status tool (and any other chat
 * client). Sections match the terminal /memory panel one-for-one.
 */
export function renderMemoryReport(input: {
  status: StatusPayload | null;
  store: StoreCounts;
  blocked: BlockedRow[];
  quarantined?: { ts: string; patterns: string[] }[];
  capture?: CaptureHealth;
}): string {
  const { status, store, blocked } = input;
  const out: string[] = ["MEMORY STATUS", ""];
  if (input.quarantined?.length) {
    out.push(
      "QUARANTINE",
      `  ${input.quarantined.length} rows withheld from recall and injection; review/release in the memory viewer.`,
    );
    for (const row of input.quarantined.slice(0, 20)) {
      out.push(
        `  ${row.ts}  ${row.patterns.join(", ") || "marked for review"}`,
      );
    }
    out.push("");
  }

  if (!status) {
    out.push(
      "CONTEXT",
      "  no epoch yet — memory has not injected this session (fresh server, or no prompt scored yet)",
    );
  } else {
    out.push("CONTEXT", ...contextLines(status));
    out.push(
      "",
      "CACHE — the receipts on your prompt-cache cost",
      ...cacheLines(status),
    );
    out.push(
      "",
      "CONTEXT WINDOW — is memory bloating your context?",
      ...windowLines(status),
    );
    out.push("", "INJECTED BLOCK (verbatim)");
    if (status.block)
      out.push(...status.block.split("\n").map((l) => `  ${l}`));
    else
      out.push(
        "  abstained — your prompt shares no content vocabulary with any memory, so nothing was injected (by design, no noise).",
      );
    out.push(
      "",
      "MEMORY ATTRIBUTION — answered from memory vs re-reading files",
      ...attributionLines(status),
    );
  }

  out.push("", "RECENT BLOCKED WRITES");
  if (!blocked.length) out.push("  (none today or yesterday)");
  for (const b of blocked) {
    out.push(`  ${b.ts}  session ${b.sid}  ${b.reason}`);
  }
  out.push(
    "  (reasons are logged via memory_evidence; the gate never deletes — it asks for a rephrase)",
  );

  out.push(
    "",
    "STORE",
    `  ${store.active} active · ${store.superseded} superseded · ${store.open} open · ${store.scopes} scopes` +
      (store.malformed
        ? ` · ${store.malformed} malformed (skipped; fix the ts= field or undo)`
        : ""),
  );
  if (store.neverRetrieved !== undefined) {
    const used = store.active - store.neverRetrieved;
    const share = store.active
      ? Math.round((store.neverRetrieved / store.active) * 100)
      : 0;
    // A ledger younger than the window cannot honestly call anything "never"
    // — it has not been watching long enough. Say what it covers instead of
    // letting day-one readers see 100% dead weight.
    const young = ledgerIsYoung(store.ledgerSince);
    const basis = young
      ? `, ledger only covers since ${store.ledgerSince ? store.ledgerSince.slice(0, 10) : "no lines yet"}`
      : "";
    out.push(
      `  retrieved ${used} rows in the last 30d; never retrieved ${store.neverRetrieved} (${share}%)${basis} — reported, not acted on`,
    );
  }
  const sizing: string[] = [];
  if (store.bytes !== undefined) {
    sizing.push(
      `${fmtBytes(store.bytes)} total · ${fmtBytes(store.bytesPerRow ?? 0)} per row`,
    );
  }
  if (store.rowsPerDay !== undefined)
    sizing.push(`${store.rowsPerDay} rows/day (30d)`);
  if (store.captureLag && store.captureLag.n) {
    sizing.push(
      `capture lag p50 ${fmtMs(store.captureLag.p50)} / p95 ${fmtMs(store.captureLag.p95)}`,
    );
  }
  // #387: capture is a separate model call outside every session's usage, so
  // anything that reads session numbers reports it as free. Render it even at
  // zero, with the reason, because "0" and "never ran" are different facts and
  // the plugin billed it as the first for its whole history.
  if (store.captureCost) {
    const c = store.captureCost;
    sizing.push(
      c.calls
        ? `capture ~${fmtCount(c.estTokens)} tok est. over ${c.calls} call${c.calls === 1 ? "" : "s"} (${fmtCount(c.promptChars)} in / ${fmtCount(c.textChars)} out, ${c.sessions} session${c.sessions === 1 ? "" : "s"}) — estimate, no provider receipt`
        : "capture 0 tok — no capture call in the window",
    );
  }
  if (sizing.length) out.push(`  ${sizing.join(" · ")}`);
  if (input.capture) {
    out.push(
      "",
      "AUTO-CAPTURE — is it off, misconfigured, armed, or alive?",
      ...captureLines(input.capture),
    );
  }
  out.push(
    "",
    "Terminal (CLI/TUI) users: /memory opens this as a live panel; the footer shows a one-line badge.",
  );
  return out.join("\n");
}
