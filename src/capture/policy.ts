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
import { conversationTurns, flattenTranscript } from "./transcript.ts";

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
  /**
   * Identity of the messages that capture consumed — the flattened prefix, not
   * its last message (#366 review, round 4). A count says how many messages were
   * consumed; it cannot say WHICH ones, and a host that replaces the transcript
   * and then lets it grow again hands back an array longer than the cursor that
   * shares nothing with it.
   */
  fp?: string;
}

// Two 32-bit accumulators plus the length: FNV-1a and a djb2-style rolling
// hash. Deterministic across restarts (a cursor is only ever compared with the
// store of the same process family), allocation-light, and strong enough for
// what it is: an equality test on the text of messages already read, never a
// security decision. Length is in the digest so two different-length prefixes
// can never agree even if both accumulators did.
function fingerprintOf(text: string): string {
  let fnv = 0x811c9dc5;
  let djb = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    fnv = Math.imul(fnv ^ c, 0x01000193);
    djb = (Math.imul(djb, 33) + c) | 0;
  }
  return `${text.length}:${(fnv >>> 0).toString(36)}:${(djb >>> 0).toString(36)}`;
}

/**
 * Identity of the FIRST `count` messages — everything the cursor claims to have
 * consumed. Undefined when there is nothing to fingerprint: not an array, a
 * count this array cannot supply, or messages that decode to no text at all.
 *
 * The WHOLE prefix, not its last message (round 4 [P2]): an ordinary assistant
 * reply repeated at the boundary position makes a replaced transcript look
 * unchanged, and no hash collision is required for that.
 *
 * Cost is one flatten of text the pass has already flattened once, in-process.
 * What the delta exists to avoid paying is the capture MODEL call, not this.
 */
export function prefixFingerprint(
  msgs: unknown,
  count: number,
): string | undefined {
  if (!Array.isArray(msgs) || count <= 0 || msgs.length < count)
    return undefined;
  const text = flattenTranscript(msgs.slice(0, count));
  return text ? fingerprintOf(text) : undefined;
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
  fp?: string,
): void {
  if (cursors.size >= MAX_CURSORS && !cursors.has(sid)) {
    const oldest = cursors.keys().next().value;
    if (oldest !== undefined) cursors.delete(oldest);
  }
  cursors.set(sid, { msgs, turn, fp });
}

export function resetCaptureCursors(): void {
  cursors.clear();
}

/**
 * Is this array still the transcript the cursor was counting (#366 review)?
 *
 * Two shapes say it is not. SHORTER than the count: compaction replaced the
 * transcript, so `since` names an index that no longer exists — a normal event,
 * not a corrupted store. LONG ENOUGH BUT A DIFFERENT PREFIX: the transcript was
 * replaced and then grew past the old count before the next capture observed the
 * swap, which a length check reads as an ordinary append while the new user rule
 * sits below the cursor at index 0.
 *
 * The prefix, message for message, is the invariant: if the first `msgs` entries
 * are the ones the last pass mined, then mining from `msgs` is correct, whatever
 * has been appended after it. Told apart from "nothing new was appended"
 * (`since` equal to the length and an unchanged prefix), which stays an empty
 * window. A cursor with no fingerprint — written before this existed, or left by
 * a pass that mined a payload with no message array behind it — falls back to the
 * length check, so an upgrade never restarts a window on its own.
 */
export function transcriptReplaced(
  msgs: unknown,
  cursor: { msgs: number; fp?: string },
): boolean {
  if (!Array.isArray(msgs)) return false;
  if (cursor.msgs === 0) return false;
  if (msgs.length < cursor.msgs) return true;
  if (cursor.fp === undefined) return false;
  return prefixFingerprint(msgs, cursor.msgs) !== cursor.fp;
}

/**
 * Slice the message array down to what has not been mined yet. Returns the
 * input unchanged when it is not an array (a seeded compaction payload of
 * unknown shape) or when nothing was consumed, so the caller's existing
 * thin-check still applies.
 */
export function deltaMessages(msgs: unknown, since: number): unknown {
  if (!Array.isArray(msgs) || since <= 0) return msgs;
  // A context that shrank past the cursor is a REPLACED transcript (compaction),
  // not a window that has been fully mined (#366 review). Mine what is there:
  // an empty window here was skipped by the thin-check WITHOUT advancing the
  // cursor, so every later turn was skipped as well until the array grew past
  // the stale count.
  if (since > msgs.length) return msgs;
  return msgs.slice(since);
}

/**
 * Did the USER state a rule or spec in the window? The signal gate reads the
 * tool ledger, so a session that only talks — "TAX_RATE must be 0.0825", no
 * edits, no gate commands — would skip the capture and lose the hint channel
 * (#339) for good when the session ends. A declarative marker in a user
 * message is the cheap stand-in for "this window can hold a durable fact".
 *
 * Deliberately loose in the SAFE direction: a false positive costs one
 * capture we would have paid for anyway; a false negative loses the user's
 * stated spec. Unknown message shapes fire.
 */
const GUIDED_MARKER =
  /\b(must|never|always|shall|rule|spec|requirement|mandatory|forbidden)\b/i;

export function guidedStatementInWindow(
  msgs: unknown,
  sinceMsgs: number,
): boolean {
  if (!Array.isArray(msgs)) return true;
  const window = msgs.slice(Math.max(0, sinceMsgs));
  if (window.length === 0) return false;
  // The SAME decode the transcript uses (#366 review): roles come from
  // `info.role` / `role` / `type`, text from `parts[]` / `content[]` / `text` /
  // a string `content`. Reading one narrow shape here meant a genuine user rule
  // in any other accepted shape got a no-signal skip before generation — the
  // exact loss this guard exists to prevent.
  const turns = conversationTurns(window);
  if (turns.length === 0) {
    // Nothing in the window decoded to a conversation turn. That is either a
    // window of non-conversation records or a message shape this build has
    // never seen, and the two are indistinguishable from here — so it fires.
    return true;
  }
  return turns.some((t) => t.role === "user" && GUIDED_MARKER.test(t.text));
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

/**
 * Gate commands that ran in this window, FAILED, and were never followed by a
 * PASS of the same family. This is the only thing a failure lesson may be about.
 *
 * The point is that a lesson must rest on the repo's own verdict, not on the
 * model's impression of what went wrong. ReMe (Findings ACL 2026) found
 * selective addition BEATS full addition, because one failed trajectory rarely
 * carries enough context for a correct analysis and yields misguided
 * experiences. So this store's failure mode is writing a wrong lesson, not
 * missing a right one. An unattested lesson is a rumour, and the runtime drops
 * the row.
 *
 * A recovered failure is excluded on purpose: FAIL then PASS means the agent
 * fixed it, and "do not do what I just did" is only a lesson while the thing is
 * still broken. `captureSignalSince` reads the same ledger for the opposite
 * purpose — a recovery is the best REASON to capture, an unrecovered failure is
 * the best thing to capture.
 *
 * One family's recovery does not attest away another family's failure: a
 * session that got its tests green and its lint red still has an open lint
 * failure.
 *
 * First-failure order, deduped by family, bounded — the block is prompt bytes on
 * every capture, and a session with more than a handful of failing gates is not
 * choosing between eight of them.
 */
export function attestedGateFailures(
  s: SessionState,
  sinceTurn: number,
): { cmd: string; arg?: string }[] {
  // Same reasoning as captureSignalSince: with no turn tracking the window is
  // meaningless rather than empty, and a policy that quietly stops reporting
  // failures is the failure mode this file exists to avoid.
  const tracked = s.turns > 0;
  const out: { cmd: string; arg?: string }[] = [];
  // Ledger order, not timestamps: `calls` is append-only, which is what
  // captureSignalSince relies on for the same FAIL-then-PASS question, and it
  // cannot be undone by two calls sharing a millisecond.
  s.calls.forEach((c, i) => {
    if (!c.gateCheck || c.status !== "FAIL" || !c.cmd) return;
    if (tracked && (c.turn ?? 0) <= sinceTurn) return;
    if (out.some((f) => f.cmd === c.cmd)) return;
    if (out.length >= 8) return;
    const recovered = s.calls
      .slice(i + 1)
      .some((l) => l.gateCheck && l.cmd === c.cmd && l.status === "PASS");
    if (recovered) return;
    out.push({ cmd: c.cmd, ...(c.arg ? { arg: c.arg } : {}) });
  });
  return out;
}
