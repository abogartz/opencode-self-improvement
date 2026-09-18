// Deterministic reflection triggers T1/T2/T4. Evidence capture is driven by
// tool results, never by a model decision. Nothing here injects into chat.
import { record } from "./evidence.ts";
import {
  session,
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
}

export function evidenceCalls(sid: string): string[] {
  return session(sid).calls.map((c) => c.call);
}

export function hasGateCheck(sid: string): boolean {
  return session(sid).calls.some((c) => c.gateCheck === true);
}
