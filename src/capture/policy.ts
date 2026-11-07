// Capture policy: WHEN a capture is worth paying for (#334).
//
// Today every turn end triggers a capture (throttled by a fixed cooldown), and
// every capture re-mines the WHOLE transcript. Two costs follow. The first is
// the number of passes: a two-hour session with a turn every six minutes is
// ~20 passes. The second is worse — each pass re-reads everything mined before,
// pays full generation price for it, and the gate then dedups most of the
// result away. You pay to produce rows you throw away.
//
// Both are fixable with facts the plugin already holds in-process at zero token
// cost, so neither gate needs a model call to decide.
import type { SessionState } from "../core/state.ts";

/**
 * How many messages of a session's context a capture has already mined. The
 * delta window is everything after this index; a session that has never been
 * captured starts at 0 and mines the whole context, which is correct.
 */
interface Cursor {
  /** Message count at the last completed capture. */
  msgs: number;
  /** Turn index at that capture; the signal window is turns after this. */
  turn: number;
}

// Bounded like every other session-keyed ledger, so a resident server cannot
// grow it. A lost cursor costs one wider capture, never a wrong row.
const MAX_CURSORS = 500;
const cursors = new Map<string, Cursor>();

export function captureCursor(sid: string): Cursor {
  return cursors.get(sid) ?? { msgs: 0, turn: 0 };
}

export function advanceCaptureCursor(
  sid: string,
  msgs: number,
  turn: number,
): void {
  if (cursors.size >= MAX_CURSORS && !cursors.has(sid)) {
    const oldest = cursors.keys().next().value;
    if (oldest !== undefined) cursors.delete(oldest);
  }
  cursors.set(sid, { msgs, turn });
}

export function resetCaptureCursors(): void {
  cursors.clear();
}

/**
 * Slice the message array down to what has not been mined yet. Returns the
 * input unchanged when it is not an array (a seeded compaction payload of
 * unknown shape) or when nothing was consumed, so the caller's existing
 * thin-check still applies.
 */
export function deltaMessages(msgs: unknown, since: number): unknown {
  if (!Array.isArray(msgs) || since <= 0) return msgs;
  return since >= msgs.length ? [] : msgs.slice(since);
}

export interface SignalVerdict {
  ok: boolean;
  /** What justified the capture, or why it did not. Logged, never injected. */
  why: string;
}

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"]);

/**
 * Did this session produce anything durable since the last capture?
 *
 * Three signals, all read off the tool ledger the plugin already keeps:
 *
 *  - `edited`          — a file was written. Most durable rows describe a
 *                        change; a turn that only read has never produced one.
 *  - `gateRecovered`   — a gate command (build/test/lint/typecheck) failed and
 *                        a later one of the same kind passed. This is the
 *                        FAIL->PASS pair `t4_learning` already records, and it
 *                        is the single most lesson-shaped event available.
 *  - `newCommandPassed`— a command passed that had never passed in this
 *                        session. The first `bun test ./src` is a fact worth
 *                        keeping; the tenth is not.
 *
 * Deliberately conservative in the SAFE direction: an unknown tool name or a
 * trimmed ledger tail can only cause a MISSED capture, and a missed capture
 * costs nothing the next signal-bearing turn cannot recover, because the
 * cursor does not advance on a skip.
 */
export function captureSignalSince(
  s: SessionState,
  sinceTurn: number,
): SignalVerdict {
  // Turn tracking never ran (no session.prompt observed), so the window is
  // meaningless rather than empty. Capture: a policy that silently stops
  // storing is the failure mode this file exists to avoid, and this is the
  // one case where "no evidence" does not mean "nothing happened".
  if (s.turns === 0) return { ok: true, why: "no-turn-tracking" };
  const inWindow = s.calls.filter((c) => (c.turn ?? 0) > sinceTurn);
  if (inWindow.some((c) => EDIT_TOOLS.has(c.tool)))
    return { ok: true, why: "edited" };
  const gates = inWindow.filter((c) => c.gateCheck);
  const failed = new Set(
    gates.filter((c) => c.status === "FAIL").map((c) => c.cmd),
  );
  if (
    failed.size &&
    gates.some((c) => c.status === "PASS" && failed.has(c.cmd))
  )
    return { ok: true, why: "gateRecovered" };
  const passedBefore = new Set(
    s.calls
      .filter(
        (c) =>
          (c.turn ?? 0) <= sinceTurn &&
          c.status === "PASS" &&
          (c.tool === "bash" || c.tool === "shell"),
      )
      .map((c) => c.cmd ?? c.arg ?? ""),
  );
  if (
    inWindow.some(
      (c) =>
        (c.tool === "bash" || c.tool === "shell") &&
        c.status === "PASS" &&
        !passedBefore.has(c.cmd ?? c.arg ?? ""),
    )
  )
    return { ok: true, why: "newCommandPassed" };
  // The window is real and held tool calls, none of them durable: reads,
  // greps, a repeated command. Skip, and leave the cursor alone so the next
  // signal-bearing turn still mines this one too.
  return { ok: false, why: "no-signal" };
}
