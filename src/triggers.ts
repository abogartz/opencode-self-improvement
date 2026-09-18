// Deterministic reflection triggers T1/T2/T4. Evidence capture is driven by
// tool results, never by a model decision. Nothing here injects into chat.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { record } from "./evidence.ts";
import { evidenceDir } from "./config.ts";
import { parseLine, readLines } from "./logfmt.ts";
import {
  session,
  setLastSeenSid,
  lastSeenSid,
  type ToolResult,
} from "./state.ts";

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

// True once the session has exercised the codebase (T1/T4 capture uses the same
// whitelist, so engagement == "a tool_result was recorded for a code tool").
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
  const sid = typeof input.sessionID === "string" ? input.sessionID : "?";
  const call = typeof input.callID === "string" ? input.callID : "?";
  const cmd = argString(input.args);
  const text = typeof out.output === "string" ? out.output : "";
  const status = classify(tool, out);
  const ts = new Date().toISOString();

  const rec: ToolResult = { call, tool, summary: summarize(text), ts, status: null };
  const s = session(sid);
  const family = tool === "bash" || tool === "shell" ? gateCmd(cmd) : null;

  // Generic capture (data, not chat).
  if (["grep", "glob", "read", "edit", "write", "bash", "shell"].includes(tool)) {
    await record("tool_result", {
      tool,
      title: tool,
      output_summary: summarize(text),
    });
    rec.status = status;
  }

  // ---- T4: completion gate FAIL -> PASS -----------------------------------
  if (family) {
    rec.gateCheck = true;
    rec.cmd = family;
    await record("gate_check", { cmd: family, status });
    if (status === "FAIL") {
      s.pendingGate = { call, cmd: family, chain: [] };
    } else if (s.pendingGate && s.pendingGate.cmd === family) {
      const pend = s.pendingGate;
      const chainCalls = [pend.call, ...pend.chain.map((c) => c.call), call];
      const edits = pend.chain.filter((c) => c.tool === "edit" || c.tool === "write");
      const fix = edits.length ? edits[edits.length - 1].call : call;
      await record(
        "t4_learning",
        {
          type: "learning",
          gate: `bash:${family}`,
          from: "FAIL",
          to: "PASS",
          gate_couple: true,
          evidence_chain: `[${chainCalls.join(",")}]`,
          fix_ref: fix,
        },
        false,
      );
      s.pendingGate = null;
    } else if (s.pendingGate) {
      s.pendingGate.chain.push(rec);
    }
    s.calls.push(rec);
    return;
  }

  // Keep the pending gate chain (grep/read/edit between FAIL and PASS).
  if (s.pendingGate) s.pendingGate.chain.push(rec);
  s.calls.push(rec);

  // ---- T1: failed -> fixed retry (non-gate tools) -------------------------
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
      );
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

export function evidenceCalls(sid: string): string[] {
  return session(sid).calls.map((c) => c.call);
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

// Called from chat.message: opening a new session closes the previous one
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
