import { decodeTranscript } from "../../src/adapters/opencode/transcript.ts";
// Capture policy: when is a capture worth paying for?
//
// The unit altitude — the signal verdicts and the cursor arithmetic. The e2e
// wiring lives in test/capture/capture-cost-policy.test.ts ("capture cost policy").
import { describe, expect, test } from "bun:test";
import {
  advanceCaptureCursor,
  captureCursor,
  captureSignalSince,
  deltaMessages,
  guidedStatementInWindow as normalizedGuidedStatementInWindow,
  prefixFingerprint as normalizedPrefixFingerprint,
  resetCaptureCursors,
  transcriptReplaced as normalizedTranscriptReplaced,
} from "../../src/capture/policy.ts";
import type { SessionState, ToolResult } from "../../src/core/state.ts";

// Keep the host-shape regression cases through the adapter's explicit decode.
const prefixFingerprint = (raw: unknown, count: number) =>
  normalizedPrefixFingerprint(decodeTranscript(raw), count);
const transcriptReplaced = (
  raw: unknown,
  cursor: { msgs: number; fp?: string },
) => normalizedTranscriptReplaced(decodeTranscript(raw), cursor);
const guidedStatementInWindow = (raw: unknown, since: number) =>
  normalizedGuidedStatementInWindow(decodeTranscript(raw), since);

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

  test("an unrecovered gate failure is a signal without edits or successes", () => {
    const s = state([
      call({
        tool: "bash",
        turn: 3,
        gateCheck: true,
        cmd: "test",
        status: "FAIL",
      }),
    ]);
    expect(captureSignalSince(s, 2)).toEqual({
      ok: true,
      why: "gateUnrecovered",
    });
    // Once this turn was captured, its still-red gate must not keep paying
    // for a capture on later read-only turns.
    expect(captureSignalSince(s, 3)).toEqual({ ok: false, why: "no-signal" });
  });

  test("a previous pass does not hide a new failure after the cursor", () => {
    const s = state([
      call({
        tool: "bash",
        turn: 1,
        gateCheck: true,
        cmd: "test",
        status: "PASS",
      }),
      call({
        tool: "bash",
        turn: 3,
        gateCheck: true,
        cmd: "test",
        status: "FAIL",
      }),
    ]);
    expect(captureSignalSince(s, 2)).toEqual({
      ok: true,
      why: "gateUnrecovered",
    });
  });

  test("a failed non-gate command or an unattested gate is not a signal", () => {
    for (const failed of [
      call({ tool: "bash", turn: 3, cmd: "grep", status: "FAIL" }),
      call({ tool: "bash", turn: 3, gateCheck: true, status: "FAIL" }),
    ])
      expect(captureSignalSince(state([failed]), 2)).toEqual({
        ok: false,
        why: "no-signal",
      });
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

  test("a fully consumed window is empty; a SHRUNK context is mined whole", () => {
    expect(deltaMessages([1, 2], 2)).toEqual([]);
    //review [P2]: compaction replaces the transcript, so `since` can point
    // past the end of an array that is simply shorter now. An empty window here
    // skipped EVERY later turn as too thin, because a skip does not advance the
    // cursor — the session stayed unmined until it grew past the old count.
    expect(deltaMessages([1, 2], 5)).toEqual([1, 2]);
  });

  test("a replaced transcript is told apart from an append", () => {
    const five = [
      { type: "user", text: "one detail" },
      { type: "assistant", text: "two detail" },
      { type: "user", text: "three detail" },
      { type: "assistant", text: "four detail" },
      { type: "user", text: "five detail" },
    ];
    const cursor = {
      msgs: 3,
      fp: prefixFingerprint(five, 3),
    };
    expect(cursor.fp).toBeDefined();
    // Nothing appended yet: same consumed prefix.
    expect(transcriptReplaced(five, cursor)).toBe(false);
    // An append keeps it.
    expect(
      transcriptReplaced([...five, { type: "assistant", text: "six" }], cursor),
    ).toBe(false);
    // Shorter: replaced by compaction.
    expect(transcriptReplaced(five.slice(0, 2), cursor)).toBe(true);
    // Replaced and then GROWN past the old count: longer than the cursor, and
    // a different consumed prefix. Length alone calls this an append.
    expect(
      transcriptReplaced(
        [
          { type: "user", text: "summary of the old transcript" },
          ...five,
          { type: "assistant", text: "six detail" },
        ],
        cursor,
      ),
    ).toBe(true);
    // A cursor with no fingerprint (written before this existed) trusts length.
    expect(transcriptReplaced(five, { msgs: 3 })).toBe(false);
    expect(transcriptReplaced(five.slice(0, 2), { msgs: 3 })).toBe(true);
    // A zero cursor is "never captured", which is never a replacement.
    expect(transcriptReplaced(five, { msgs: 0 })).toBe(false);
    // A seeded payload of unknown shape is not an array to compare.
    expect(transcriptReplaced("seeded payload", { msgs: 9, fp: "x" })).toBe(
      false,
    );
  });

  test("a fingerprint is stable and content-specific", () => {
    const a = prefixFingerprint([{ type: "user", text: "alpha detail" }], 1);
    expect(a).toBe(
      prefixFingerprint([{ type: "user", text: "alpha detail" }], 1),
    );
    expect(a).not.toBe(
      prefixFingerprint([{ type: "user", text: "beta detail" }], 1),
    );
    expect(prefixFingerprint([], 1)).toBeUndefined();
    expect(prefixFingerprint(undefined, 1)).toBeUndefined();
    // Asking for more messages than exist is not a prefix of this array.
    expect(prefixFingerprint([{ type: "user", text: "x" }], 4)).toBeUndefined();
  });

  // ONE message cannot prove the consumed prefix is the same
  // prefix. An ordinary reply repeated at the boundary position is not an FNV
  // collision — it is a different conversation wearing the same sentence.
  test("a repeated boundary message does not hide a replaced prefix", () => {
    const reply = { type: "assistant", text: "Done. The change is committed." };
    const old = [
      { type: "user", text: "fix pricing in src/a.ts" },
      reply,
      { type: "user", text: "now round the total" },
      reply,
      { type: "user", text: "and update the docs" },
      reply,
    ];
    const cursor = { msgs: 6, fp: prefixFingerprint(old, 6) };
    expect(cursor.fp).toBeDefined();
    expect(transcriptReplaced(old, cursor)).toBe(false);
    // Replaced: new guidance at index 0, the SAME reply text at index 5.
    const next = [
      { type: "user", text: "shipping must be free at 100.00" },
      reply,
      { type: "user", text: "the tax rate is 8.25 percent" },
      reply,
      { type: "user", text: "summarise the session" },
      reply,
      { type: "user", text: "now the DELTA work" },
      reply,
    ];
    expect(transcriptReplaced(next, cursor)).toBe(true);
    // An append on top of the SAME prefix stays an append, same reply or not.
    expect(
      transcriptReplaced([...old, { type: "user", text: "next" }], cursor),
    ).toBe(false);
  });

  test("a non-array payload passes through untouched", () => {
    expect(deltaMessages(undefined, 3)).toBe(undefined);
    expect(deltaMessages(decodeTranscript("seeded string"), 3)).toBeUndefined();
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

describe("guidedStatementInWindow (hint-channel guard)", () => {
  test("a user spec statement in the window is a signal", () => {
    expect(
      guidedStatementInWindow(
        [
          { type: "user", text: "The constant TAX_RATE must be 0.0825." },
          { type: "assistant", content: [{ type: "text", text: "ok" }] },
        ],
        0,
      ),
    ).toBe(true);
    // role= shape (host context) works too.
    expect(
      guidedStatementInWindow(
        [
          {
            role: "user",
            content: [{ type: "text", text: "never edit docs" }],
          },
        ],
        0,
      ),
    ).toBe(true);
  });

  test("questions and assistant text are not signals; unknown shapes fire", () => {
    expect(
      guidedStatementInWindow(
        [
          { type: "user", text: "look at the pricing module" },
          {
            type: "assistant",
            content: [{ type: "text", text: "it must be tax" }],
          },
        ],
        0,
      ),
    ).toBe(false);
    expect(guidedStatementInWindow("seeded payload", 0)).toBe(true);
    // Before the cursor: already mined, not a signal.
    expect(
      guidedStatementInWindow(
        [{ type: "user", text: "TAX_RATE must be 0.0825" }, ...[]],
        1,
      ),
    ).toBe(false);
  });

  //review [P2]: the guard decoded its own narrow message shape, so genuine
  // user rules in shapes the capture transcript parser accepts got a no-signal
  // skip before generation — the exact loss the guard exists to prevent. It now
  // shares that decoder, so there is one definition of "who said this line".
  test("every shape the transcript parser accepts is read the same way", () => {
    const rule = "The constant TAX_RATE must be 0.0825.";
    for (const msg of [
      // V1 role + string content.
      { role: "user", content: rule },
      // V1 role + parts.
      { info: { role: "user" }, parts: [{ type: "text", text: rule }] },
      // 2.2.5 live shape.
      { id: "m1", time: 1, type: "user", text: rule },
      // 2.2.5 with the text in a content part.
      { type: "user", content: [{ type: "text", text: rule }] },
    ]) {
      expect(guidedStatementInWindow([msg], 0)).toBe(true);
    }
    // The same shapes, said by the assistant: still not the user's rule.
    for (const msg of [
      { role: "assistant", content: rule },
      { info: { role: "assistant" }, parts: [{ type: "text", text: rule }] },
      { type: "assistant", text: rule },
    ]) {
      expect(guidedStatementInWindow([msg], 0)).toBe(false);
    }
  });

  test("a window the decoder cannot read at all fires rather than assumes", () => {
    expect(guidedStatementInWindow([{ weird: "record" }], 0)).toBe(true);
    // A non-conversation record alone (2.2.5 puts `idle` in the same array)
    // decodes to no turns, and "no turns" is indistinguishable from "a shape
    // this build cannot read". Both fire: a wasted capture costs one model call
    // under a cooldown, a missed rule costs the hint channel for good.
    expect(guidedStatementInWindow([{ type: "idle" }], 0)).toBe(true);
  });
});
