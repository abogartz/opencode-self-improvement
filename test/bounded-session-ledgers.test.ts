// #224: the ledgers that grow with work are bounded. Pins four contracts:
// (1) the sessions Map evicts beyond SESSION_CAP (a resident server must not
//     hold a SessionState per session forever);
// (2) the per-session calls ledger is capped at CALLS_CAP while the lifetime
//     counters (callsTotal / reDerives) keep the telemetry counts truthful;
// (3) engagement and gate-check grounding survive the cap (sticky flags);
// (4) the frontier-injection "once per process" set is bounded by SESSION_CAP,
//     observable as a second frontier_injected row after eviction;
// (5) repokey's session cache evicts at the SHARED SESSION_CAP imported from
//     core/lru.ts, so the two caps cannot drift.
// Hermetic: temp OPENCODE_MEMORY_DIR.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_CAP } from "../src/core/lru.ts";
import { resetState, session } from "../src/core/state.ts";
import {
  afterTool,
  callsFor,
  hasEngagement,
  hasGateCheck,
  writeEvidence,
} from "../src/capture/triggers.ts";
import { systemDigest } from "../src/inject/digest.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { loadAll } from "../src/store/files/load.ts";
import {
  rememberSessionDir,
  resetSessionScopes,
  sessionDirFirm,
  setRepoScope,
} from "../src/identity/repokey.ts";
import { ev, readEvidenceLog as evidence } from "./helpers/logfmt.ts";
import { removeStore } from "./helpers/remove-store.ts";

// Pinned literal of src/capture/triggers.ts's CALLS_CAP (#224), captured the
// way boundaries.test.ts captures the wire contract: a deliberate move of the
// cap has to be said out loud here. Literal (not import) so this file also
// compiles and fails BEHAVIORALLY at the merge-base, where the ledgers were
// unbounded.
const CALLS_CAP = 4096;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-bounded-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
  resetSessionScopes();
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

test("sessions Map evicts beyond SESSION_CAP; an evicted session starts over", () => {
  const first = session("osi-224-s0");
  first.turns = 7;
  for (let i = 1; i <= SESSION_CAP; i++) session(`osi-224-s${i}`);
  const again = session("osi-224-s0");
  expect(again).not.toBe(first);
  expect(again.turns).toBe(0);
});

test("calls ledger is capped and lifetime counters keep the counts truthful", async () => {
  const sid = "osi-224-calls";
  for (let i = 0; i < CALLS_CAP + 50; i++) {
    await afterTool(
      {
        tool: "grep",
        sessionID: sid,
        callID: `c${i}`,
        args: { pattern: "needle" },
      },
      { output: "match" },
    );
  }
  const s = session(sid);
  expect(s.calls.length).toBe(CALLS_CAP);
  expect(s.callsTotal).toBe(CALLS_CAP + 50);
  expect(s.reDerives).toBe(CALLS_CAP + 50);
  expect(typeof s.firstCallTs).toBe("string");
  expect(writeEvidence(sid).evidenceCallsCount).toBe(CALLS_CAP + 50);
  expect(callsFor(sid).length).toBe(CALLS_CAP);
});

test("engagement and gate-check grounding survive the call cap", async () => {
  const sid = "osi-224-sticky";
  await afterTool(
    {
      tool: "bash",
      sessionID: sid,
      callID: "g0",
      args: { command: "bun run lint" },
    },
    { output: "ok" },
  );
  expect(hasGateCheck(sid)).toBe(true);
  expect(hasEngagement(sid)).toBe(true);
  // Non-engagement, non-captured tool: pushes the engagement and gate-check
  // records out of the retained tail.
  for (let i = 0; i < CALLS_CAP + 10; i++) {
    await afterTool(
      { tool: "web_search", sessionID: sid, callID: `w${i}` },
      { output: "x" },
    );
  }
  expect(session(sid).calls.length).toBe(CALLS_CAP);
  expect(hasGateCheck(sid)).toBe(true);
  expect(hasEngagement(sid)).toBe(true);
});

test("frontier injection set is bounded: an evicted session re-records frontier_injected", async () => {
  await appendMemory({
    type: "context",
    scope: "osi224",
    content: "open thread for the frontier bound test",
    status: "open",
  });
  const rows = await loadAll();
  expect(rows.length).toBe(1);
  for (let i = 0; i <= SESSION_CAP; i++) {
    await systemDigest(
      { sessionID: `osi-224-fr-${i}` },
      { system: [] as string[] },
      { rows },
    );
  }
  const sid = "osi-224-fr-0";
  const before = ev(evidence(), "frontier_injected").filter(
    (l) => l.session === sid,
  ).length;
  expect(before).toBe(1);
  // sid-0 was the oldest of SESSION_CAP+1 injections, so the shared LRU
  // evicted it: the next digest treats it as unseen and records again.
  await systemDigest({ sessionID: sid }, { system: [] as string[] }, { rows });
  const after = ev(evidence(), "frontier_injected").filter(
    (l) => l.session === sid,
  ).length;
  expect(after).toBe(2);
});

test("repokey session cache evicts at the shared SESSION_CAP (no drift)", () => {
  // The bySession cache under test is keyed by session ID, so one existing
  // fixture directory (removed by afterEach) pins the same eviction. Distinct
  // mkdtemp dirs made every insert resolve through real `git` subprocesses:
  // that loop took 5684.99ms on the Windows runner and timed out the 5s
  // default (#287 review F1), and leaked its dirs outside `root`.
  for (let i = 0; i <= SESSION_CAP; i++)
    rememberSessionDir(`osi-224-rk-${i}`, root);
  expect(sessionDirFirm("osi-224-rk-0")).toBeUndefined();
  expect(sessionDirFirm(`osi-224-rk-${SESSION_CAP}`)).toBe(root);
});
