// Per-session in-memory state shared by the hooks and the gate pipeline.
// Deterministic: only tool results and tool invocations mutate it, never the
// model. Reset between scenario runs with resetState().
import { SESSION_CAP, SessionLru } from "./lru.ts";

export interface ToolResult {
  call: string;
  tool: string;
  summary: string;
  ts: string;
  status: "FAIL" | "PASS" | null;
  cmd?: string;
  gateCheck?: boolean;
  // Input arg that identifies the target (command / pattern / path), kept for
  // memory attribution (src/attribution.ts): what the call was looking at.
  arg?: string;
  // Turn index (from markTurn) at the time of the call, for ordering.
  turn?: number;
}

export interface FirstTap {
  call: string;
  turn: number;
  ts: string;
}

export interface SessionState {
  sid: string;
  calls: ToolResult[];
  // Last observed status per tool, so a FAIL->PASS transition is visible.
  lastByTool: Map<string, { status: "FAIL" | "PASS"; call: string; emitted: boolean }>;
  // A pending completion-gate failure awaiting a later PASS.
  pendingGate: {
    call: string;
    cmd: string;
    chain: string[];
    count: number;
    fix?: { call: string; index: number };
  } | null;
  // Bounded provenance for write telemetry (#163), independent of the full
  // calls ledger used by grounding, attribution, and convergence.
  writeEvidence?: {
    recent: string[];
    gateCheck?: string;
    gateRecovery?: [string, string, string];
    toolRecovery?: [string, string];
  };
  // Session-convergence tracking (time-to-frontier): completed-message count,
  // first activity time, and the first memory_recall that surfaced an open
  // thread. Deterministic: derived only from queued messages and tool results.
  turns: number;
  firstActivityTs?: string;
  firstTap?: FirstTap;
  finalized: boolean;
}

// Rows this session promoted, for the riding-bytes rule (#165): a session must
// not pay a prompt-cache bust to be shown a fact it wrote itself, because that
// fact is already in its transcript. Filled where a write is promoted (the one
// place a row is created ON behalf of a named session — the viewer's own writes
// are deliberately not attributed), read by the epoch refresh.
//
// In-process on purpose. Persisting an author field would need a store
// migration and a privacy review (it records which session wrote what) to cover
// only the server-restart edge case, and a lost entry degrades to today's
// behavior — one bust — never to a wrong freeze. Bounded by the same cap as
// every other session-keyed ledger, so a resident server cannot grow it.
const authoredRows = new Map<string, Set<string>>();
const authoredOrder = new SessionLru(SESSION_CAP, (sid) => {
  authoredRows.delete(sid);
});
const NO_ROWS: ReadonlySet<string> = new Set();

export function noteAuthored(sid: string | undefined, ts: string): void {
  if (!sid || sid === "?") return;
  let rows = authoredRows.get(sid);
  if (!rows) {
    rows = new Set();
    authoredRows.set(sid, rows);
  }
  rows.add(ts);
  authoredOrder.touch(sid);
}

export function authoredFor(sid: string | undefined): ReadonlySet<string> {
  if (!sid) return NO_ROWS;
  return authoredRows.get(sid) ?? NO_ROWS;
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
  authoredRows.clear();
  current = { sid: "?", call: "?", tool: "?" };
  lastSeenSidVar = null;
}
