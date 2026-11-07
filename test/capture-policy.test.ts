// Capture policy (#334): when is a capture worth paying for?
//
// The unit altitude — the signal verdicts and the cursor arithmetic. The e2e
// wiring lives in test/capture.test.ts ("capture cost policy").
import { describe, expect, test } from "bun:test";
import {
  advanceCaptureCursor,
  captureCursor,
  captureSignalSince,
  deltaMessages,
  resetCaptureCursors,
} from "../src/capture/policy.ts";
import type { SessionState, ToolResult } from "../src/core/state.ts";

const call = (over: Partial<ToolResult>): ToolResult => ({
  call: `c-${Math.random().toString(36).slice(2, 8)}`,
  tool: "read",
  summary: "",
  ts: "2026-01-01T00:00:00.000Z",
  status: null,
  ...over,
});

const state = (calls: ToolResult[], turns = 5): SessionState =>
  ({
    sid: "ses-1",
    calls,
    callsTotal: calls.length,
    reDerives: 0,
    sawEngagement: true,
    sawGateCheck: false,
    lastByTool: new Map(),
    pendingGate: null,
    turns,
    finalized: false,
  }) as SessionState;

describe("captureSignalSince", () => {
  test("an edit in the window is a signal", () => {
    expect(
      captureSignalSince(state([call({ tool: "edit", turn: 3 })]), 2).why,
    ).toBe("edited");
    expect(
      captureSignalSince(state([call({ tool: "write", turn: 3 })]), 2).ok,
    ).toBe(true);
  });

  test("an edit BEFORE the window is not", () => {
    expect(
      captureSignalSince(state([call({ tool: "edit", turn: 1 })]), 2),
    ).toEqual({ ok: false, why: "no-signal" });
  });

  test("a gate that failed then passed is the strongest signal", () => {
    const s = state(
      [
        call({
          tool: "bash",
          turn: 3,
          gateCheck: true,
          cmd: "test",
          status: "FAIL",
        }),
        call({
          tool: "bash",
          turn: 4,
          gateCheck: true,
          cmd: "test",
          status: "PASS",
        }),
      ],
      4,
    );
    expect(captureSignalSince(s, 2).why).toBe("gateRecovered");
  });

  test("a gate that only failed is not a recovery", () => {
    const s = state([
      call({
        tool: "bash",
        turn: 3,
        gateCheck: true,
        cmd: "test",
        status: "FAIL",
      }),
    ]);
    expect(captureSignalSince(s, 2).ok).toBe(false);
  });

  test("a gate that passed and then passed again is not a recovery", () => {
    const s = state([
      call({
        tool: "bash",
        turn: 3,
        gateCheck: true,
        cmd: "lint",
        status: "PASS",
      }),
      call({
        tool: "bash",
        turn: 4,
        gateCheck: true,
        cmd: "lint",
        status: "PASS",
      }),
    ]);
    // No FAIL, so not gateRecovered; the first PASS is still a new command.
    expect(captureSignalSince(s, 2).why).toBe("newCommandPassed");
  });

  test("a command that already passed earlier is not new", () => {
    const s = state([
      call({ tool: "bash", turn: 1, cmd: "bun test", status: "PASS" }),
      call({ tool: "bash", turn: 4, cmd: "bun test", status: "PASS" }),
    ]);
    expect(captureSignalSince(s, 2).ok).toBe(false);
  });

  test("a first-time passing command is a signal", () => {
    const s = state([
      call({ tool: "bash", turn: 1, cmd: "bun install", status: "PASS" }),
      call({ tool: "bash", turn: 4, cmd: "bun test ./src", status: "PASS" }),
    ]);
    expect(captureSignalSince(s, 2).why).toBe("newCommandPassed");
  });

  test("a window of pure reads is not a signal", () => {
    const s = state([
      call({ tool: "read", turn: 3 }),
      call({ tool: "grep", turn: 3, status: "PASS" }),
    ]);
    expect(captureSignalSince(s, 2)).toEqual({ ok: false, why: "no-signal" });
  });

  test("no turn tracking means the window is meaningless, so capture", () => {
    // The silent-death case this must never produce: a host that never calls
    // session.prompt leaves turns at 0, so every call falls outside every
    // window. Treating that as "nothing happened" would stop capture forever
    // with nothing in the store to show for it.
    const s = state([call({ tool: "edit", turn: 0 })], 0);
    expect(captureSignalSince(s, 0)).toEqual({
      ok: true,
      why: "no-turn-tracking",
    });
  });
});

describe("deltaMessages", () => {
  test("slices past the consumed prefix", () => {
    expect(deltaMessages([1, 2, 3, 4], 2)).toEqual([3, 4]);
  });

  test("a zero cursor is the whole array, unchanged identity", () => {
    const m = [1, 2];
    expect(deltaMessages(m, 0)).toBe(m);
  });

  test("a fully consumed window is empty, which the thin-check then skips", () => {
    expect(deltaMessages([1, 2], 2)).toEqual([]);
    expect(deltaMessages([1, 2], 5)).toEqual([]);
  });

  test("a non-array payload passes through untouched", () => {
    expect(deltaMessages(undefined, 3)).toBe(undefined);
    expect(deltaMessages("seeded string", 3)).toBe("seeded string");
  });
});

describe("the capture cursor", () => {
  test("an uncaptured session starts at the beginning", () => {
    resetCaptureCursors();
    expect(captureCursor("ses-new")).toEqual({ msgs: 0, turn: 0 });
  });

  test("advance records both the message count and the turn", () => {
    resetCaptureCursors();
    advanceCaptureCursor("ses-a", 12, 4);
    expect(captureCursor("ses-a")).toEqual({ msgs: 12, turn: 4 });
  });

  test("the map stays bounded, oldest first", () => {
    resetCaptureCursors();
    for (let i = 0; i < 505; i++) advanceCaptureCursor(`s${i}`, i, i);
    expect(captureCursor("s0")).toEqual({ msgs: 0, turn: 0 }); // evicted
    expect(captureCursor("s504")).toEqual({ msgs: 504, turn: 504 });
  });
});
