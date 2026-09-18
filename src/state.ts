// Per-session in-memory state shared by the hooks and the gate pipeline.
// Deterministic: only tool results and tool invocations mutate it, never the
// model. Reset between scenario runs with resetState().

export interface ToolResult {
  call: string;
  tool: string;
  summary: string;
  ts: string;
  status: "FAIL" | "PASS" | null;
  cmd?: string;
  gateCheck?: boolean;
}

export interface FirstTap {
  call: string;
  turn: number;
  ts: string;
}

export interface SessionState {
  sid: string;
  calls: ToolResult[];
  // T1: last observed status per tool, so a FAIL->PASS transition is visible.
  lastByTool: Map<string, { status: "FAIL" | "PASS"; call: string; emitted: boolean }>;
  // T4: a pending completion-gate failure awaiting a later PASS.
  pendingGate: {
    call: string;
    cmd: string;
    chain: ToolResult[];
  } | null;
  // Session-convergence tracking (time-to-frontier): completed-message count,
  // first activity time, and the first memory_recall that surfaced an open
  // thread. Deterministic: derived only from queued messages and tool results.
  turns: number;
  firstActivityTs?: string;
  firstTap?: FirstTap;
  finalized: boolean;
}

// Newest message-bearing session seen this process. Opening a session finalizes
// the previous one (there is no session-end hook on the host surface).
let lastSeenSidVar: string | null = null;

export function lastSeenSid(): string | null {
  return lastSeenSidVar;
}

export function setLastSeenSid(sid: string): void {
  lastSeenSidVar = sid;
}

const sessions = new Map<string, SessionState>();

export function session(sid: string): SessionState {
  let s = sessions.get(sid);
  if (!s) {
    s = { sid, calls: [], lastByTool: new Map(), pendingGate: null, turns: 0, finalized: false };
    sessions.set(sid, s);
  }
  return s;
}

let current: { sid: string; call: string; tool: string } = {
  sid: "?",
  call: "?",
  tool: "?",
};

export function setCurrent(input: {
  sessionID?: unknown;
  callID?: unknown;
  tool?: unknown;
}): void {
  if (typeof input.sessionID === "string") current.sid = input.sessionID;
  if (typeof input.callID === "string") current.call = input.callID;
  if (typeof input.tool === "string") current.tool = input.tool;
}

export function getCurrent(): { sid: string; call: string; tool: string } {
  return current;
}

export function resetState(): void {
  sessions.clear();
  current = { sid: "?", call: "?", tool: "?" };
  lastSeenSidVar = null;
}
