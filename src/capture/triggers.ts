// Deterministic reflection triggers T1/T2/T4. Evidence capture is driven by
// tool results, never by a model decision. Nothing here injects into chat.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { record } from "../evidence/record.ts";
import { evidenceDir } from "../core/config/paths.ts";
import { parseLine } from "../core/logfmt/format.ts"
import { readLines } from "../core/logfmt/read.ts";
import { redactSecrets } from "../store/secrets.ts";
import {
  session,
  setLastSeenSid,
  lastSeenSid,
  type SessionState,
  type ToolResult,
} from "../core/state.ts";

export interface AfterInput {
  tool?: unknown;
  sessionID?: unknown;
  callID?: unknown;
  args?: unknown;
}

export interface AfterOutput {
  output?: unknown;
  metadata?: Record<string, unknown>;
}

// Code-touching tools. Seeing one of these in the session is evidence the model
// actually engaged with the code it later writes about (GATE-4's behavior-
// grounded injection): reading/grepping a shot of live code, editing it, or
// running commands. Empirical behavior substitutes for hand-copied refs.
const ENGAGEMENT_TOOLS = new Set(["grep", "glob", "read", "edit", "write", "bash", "shell"]);

const RECENT_EVIDENCE_CALLS = 10;
// Pending recovery stores IDs only; the full attribution ledger stays in calls.
function trackPending(s: SessionState, rec: ToolResult): void {
  const pending = s.pendingGate;
  if (!pending) return;
  pending.count++;
  if (rec.tool === "edit" || rec.tool === "write") {
    pending.fix = { call: rec.call, index: pending.count };
  }
  pending.chain.push(rec.call);
  if (pending.chain.length > RECENT_EVIDENCE_CALLS) pending.chain.shift();
}
// Recent engagement + latest gate check + FAIL/fix/PASS + tool FAIL/PASS.
export const MAX_WRITE_EVIDENCE_REFS = RECENT_EVIDENCE_CALLS + 1 + 3 + 2;

function trackCall(s: SessionState, rec: ToolResult): void {
  s.calls.push(rec);
  s.writeEvidence ??= { recent: [] };
  const evidence = s.writeEvidence;
  if (ENGAGEMENT_TOOLS.has(rec.tool)) {
    evidence.recent.push(rec.call);
    if (evidence.recent.length > RECENT_EVIDENCE_CALLS) evidence.recent.shift();
  }
  if (rec.gateCheck) evidence.gateCheck = rec.call;
}

// True once the session has exercised the codebase (the FAIL->PASS signals use
// the same whitelist, so engagement == "a tool_result was recorded for a code
// tool").
export function hasEngagement(sid: string): boolean {
  return session(sid).calls.some((c) => ENGAGEMENT_TOOLS.has(c.tool));
}

const GATE_CMDS: [RegExp, string][] = [
  [/vitest/, "vitest"],
  [/playwright/, "playwright"],
  [/lint/, "lint"],
  [/build:source|tsc\b/, "tsc"],
];

export function gateCmd(cmd: string): string | null {
  for (const [re, name] of GATE_CMDS) if (re.test(cmd)) return name;
  return null;
}

function argString(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const v = a.command ?? a.cmd ?? a.pattern ?? a.query ?? a.path ?? a.filePath;
  return typeof v === "string" ? v : "";
}

function exitCode(out: AfterOutput): number | undefined {
  const m = out.metadata;
  if (!m) return undefined;
  const v = m.exitCode ?? m.exit ?? m.code;
  return typeof v === "number" ? v : undefined;
}

function classify(tool: string, out: AfterOutput): "FAIL" | "PASS" {
  const text = typeof out.output === "string" ? out.output : "";
  if (tool === "bash" || tool === "shell") {
    const code = exitCode(out);
    if (typeof code === "number") return code === 0 ? "PASS" : "FAIL";
    if (/\b(failed|failure|error|not found|command failed)\b/i.test(text)) return "FAIL";
    return "PASS";
  }
  if (tool === "grep" || tool === "glob") {
    if (/no (matches|files|results)|no output found|did not match/i.test(text)) return "FAIL";
    if (/\d+\s+match/i.test(text)) return "PASS";
    return text.trim() ? "PASS" : "FAIL";
  }
  return "PASS";
}

function summarize(text: string, n = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

export async function afterTool(input: AfterInput, out: AfterOutput): Promise<void> {
  const tool = typeof input.tool === "string" ? input.tool : "?";
  const sid = typeof input.sessionID === "string" ? input.sessionID : undefined;
  const call = typeof input.callID === "string" ? input.callID : "?";
  const cmd = argString(input.args);
  const text = typeof out.output === "string" ? out.output : "";
  // Redact the COMPLETE tool text before folding/truncating (#128): summarize
  // first would cut a token at the 80-char boundary or strip a PEM END marker,
  // and the surviving fragment would persist byte-for-byte in evidence.
  const safeText = text ? redactSecrets(text) : "";
  const status = classify(tool, out);
  const ts = new Date().toISOString();

  const s = session(sid ?? "?");
  const rec: ToolResult = {
    call,
    tool,
    summary: summarize(safeText),
    ts,
    status: null,
    arg: cmd || undefined,
    turn: s.turns,
  };
  const family = tool === "bash" || tool === "shell" ? gateCmd(cmd) : null;

  // Generic capture (data, not chat). The output_summary is telemetry about
  // the call (tool name + a short, redacted glimpse); the session/repo scoping
  // of evidence reads is tracked separately (#128 acceptance, #130).
  if (["grep", "glob", "read", "edit", "write", "bash", "shell"].includes(tool)) {
    await record(
      "tool_result",
      {
        tool,
        title: tool,
        output_summary: summarize(safeText),
      },
      true,
      sid,
    );
    rec.status = status;
  }

  // ---- Completion gate FAIL -> PASS ----------------------------------------
  if (family) {
    rec.gateCheck = true;
    rec.cmd = family;
    await record("gate_check", { cmd: family, status }, true, sid);
    if (status === "FAIL") {
      s.pendingGate = { call, cmd: family, chain: [], count: 0 };
    } else if (s.pendingGate && s.pendingGate.cmd === family) {
      const pend = s.pendingGate;
      const fix = pend.fix?.call ?? call;
      const oldFix = pend.fix && pend.fix.index <= pend.count - pend.chain.length;
      const chainCalls = [pend.call, ...(oldFix ? [fix] : []), ...pend.chain, call];
      await record(
        "t4_learning",
        {
          type: "learning",
          gate: `bash:${family}`,
          from: "FAIL",
          to: "PASS",
          gate_couple: true,
          evidence_chain: `[${chainCalls.join(",")}]`,
          evidence_chain_count: pend.count + 2,
          fix_ref: fix,
        },
        false,
        sid,
      );
      s.writeEvidence ??= { recent: [] };
      s.writeEvidence.gateRecovery = [pend.call, fix, call];
      s.pendingGate = null;
    } else if (s.pendingGate) {
      trackPending(s, rec);
    }
    trackCall(s, rec);
    return;
  }

  // Keep the pending gate chain (grep/read/edit between FAIL and PASS).
  trackPending(s, rec);
  trackCall(s, rec);

  // ---- Failed -> fixed retry (non-gate tools) -------------------------------
  if (["grep", "glob", "read"].includes(tool)) {
    const prev = s.lastByTool.get(tool);
    if (prev && prev.status === "FAIL" && status === "PASS" && !prev.emitted) {
      prev.emitted = true;
      await record(
        "t1_evidence",
        {
          from: "FAIL",
          to: "PASS",
          evidence_refs: `[${prev.call},${call}]`,
          kind: "learning",
        },
        false,
        sid,
      );
      s.writeEvidence ??= { recent: [] };
      s.writeEvidence.toolRecovery = [prev.call, call];
    }
    s.lastByTool.set(tool, { status, call, emitted: prev?.emitted ?? false });
  }
}

export async function onCompacting(input: AfterInput): Promise<void> {
  const sid = typeof input.sessionID === "string" ? input.sessionID : "?";
  const s = session(sid);
  await record(
    "t2_compaction",
    {
      session: sid,
      captured_calls: s.calls.length,
      pending_gate: s.pendingGate ? s.pendingGate.call : "-",
    },
    false,
  );
  await finalizeSession(sid);
}

// Full IDs for callers that explicitly need the ledger. Production write
// contexts use writeEvidence so they do not allocate this growing list.
export function evidenceCalls(sid: string): string[] {
  return session(sid).calls.map((c) => c.call);
}

// A detached, bounded snapshot for GateContext. Do not map the entire ledger
// on each write: it grows throughout the session. Pin the actual trigger
// witnesses when recorded rather than trying to reconstruct a FAIL->PASS
// pairing from a cropped tail. The full ledger remains available above.
export function writeEvidence(sid: string): { evidenceCalls: string[]; evidenceCallsCount: number } {
  const s = session(sid);
  const evidence = s.writeEvidence;
  const refs = new Set([
    ...(evidence?.gateRecovery ?? []),
    ...(evidence?.toolRecovery ?? []),
    ...(evidence?.gateCheck !== undefined ? [evidence.gateCheck] : []),
    ...(evidence?.recent ?? []),
  ]);
  return { evidenceCalls: [...refs], evidenceCallsCount: s.calls.length };
}

// The full per-session tool ledger, for memory attribution (src/attribution.ts).
export function callsFor(sid: string): ToolResult[] {
  return session(sid).calls;
}

export function hasGateCheck(sid: string): boolean {
  return session(sid).calls.some((c) => c.gateCheck === true);
}

// ---- Session-convergence tracking (time-to-frontier) -----------------------
// The measurable win: sessions should reach the previous frontier quickly and
// stop re-deriving/ re-litigating. Everything here is deterministic — turn
// counts from completed messages, "frontier tap" from the FIRST memory_recall
// that surfaced an open thread, re-derivation from grep/glob/read results. The
// per-session rollup lands in EVIDENCE (data, never chat — I3), and only a
// tiny aggregate fact may ride the frontier block in the digest.

export function markTurn(sid: string): void {
  const s = session(sid);
  s.turns++;
  if (!s.firstActivityTs) s.firstActivityTs = new Date().toISOString();
}

export function markFrontierTap(sid: string, call: string): void {
  const s = session(sid);
  if (s.firstTap) return;
  s.firstTap = { call, turn: s.turns, ts: new Date().toISOString() };
}

export function firstFrontierTap(sid: string): { call: string; turn: number; ts: string } | undefined {
  return session(sid).firstTap;
}

// Idempotent per-session rollup. Emitted only when the session had any
// activity (a message or a tool result), so noise-free sessions stay silent.
export async function finalizeSession(sid: string): Promise<void> {
  const s = session(sid);
  if (s.finalized) return;
  s.finalized = true;
  if (s.calls.length === 0 && s.turns === 0) return;
  const tap = s.firstTap;
  const start = s.firstActivityTs ?? s.calls[0]?.ts;
  const ms =
    tap && start ? Math.max(0, Date.parse(tap.ts) - Date.parse(start)) : undefined;
  await record(
    "session_convergence",
    {
      session: sid,
      turns: s.turns,
      tap_at: tap ? tap.call : "-",
      turns_to_tap: tap ? tap.turn : undefined,
      re_derives: s.calls.filter((c) => ["grep", "glob", "read"].includes(c.tool)).length,
      ms_to_tap: ms,
      calls: s.calls.length,
    },
    false,
  );
}

// Called from the session prompt hook: opening a new session closes the previous one
// (the host has no session-end hook, so a push handoff — new session in the
// same process — is the closest deterministic close).
export async function checkNewSession(sid: string): Promise<void> {
  if (sid === lastSeenSid()) return;
  const prev = lastSeenSid();
  if (prev) await finalizeSession(prev);
  setLastSeenSid(sid);
}

// Tiny aggregate for the frontier digest block: how many recent sessions
// reached the frontier, and how fast on average. Data-only; never the evidence
// logfmt itself. Empty string when there is no measurement yet (fresh install).
// Merges two evidence streams: the per-session rollup (has turns_to_tap) and
// the frontier_tapped rows (a tap that landed AFTER the session was finalized
// at compaction — the late-tap race — so the rollup's tap_at was already "-").
export async function recentConvergenceSummary(limit = 6): Promise<string> {
  const dir = evidenceDir();
  if (!existsSync(dir)) return "";
  const files: string[] = [];
  for await (const f of new Bun.Glob("*.logfmt").scan(dir)) files.push(join(dir, f));
  files.sort();
  // sid -> tap turn from frontier_tapped rows (late taps lost from rollups).
  const lateTaps = new Map<string, number>();
  const rows: { session: string; turn: number | null }[] = [];
  for (const file of files) {
    for (const line of await readLines(file)) {
      const p = parseLine(line);
      if (!p) continue;
      if (p.ev === "frontier_tapped" && typeof p.sid === "string") {
        const t = Number(p.turn);
        if (Number.isFinite(t) && !lateTaps.has(p.sid)) lateTaps.set(p.sid, t);
      } else if (p.ev === "session_convergence") {
        const tap =
          typeof p.turns_to_tap === "string" && p.turns_to_tap !== ""
            ? Number(p.turns_to_tap)
            : NaN;
        rows.push({
          session: String(p.session ?? ""),
          turn: Number.isFinite(tap) ? tap : null,
        });
      }
    }
  }
  const recent = rows.slice(-limit);
  const tapped = recent.filter(
    (r) => r.turn !== null || lateTaps.has(r.session),
  );
  if (!recent.length || !tapped.length) return "";
  const sum = tapped.reduce((a, r) => a + (r.turn ?? lateTaps.get(r.session) ?? 0), 0);
  const avg = sum / tapped.length;
  const label = avg % 1 === 0 ? String(avg) : avg.toFixed(1);
  return `${recent.length} sessions tracked, ${tapped.length} reached the frontier (first tap ~${label} turns)`;
}
