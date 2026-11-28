import type { CaptureTranscript } from "../host/capture.ts";

const TRANSCRIPT_USER_TURN_CAP = 40;

interface ParsedTurn {
  role: "user" | "assistant";
  text: string;
}

/** Render recent turns after delta slicing, without changing source cursor slots. */
function parseTurns(msgs: CaptureTranscript | undefined): ParsedTurn[] {
  const out: ParsedTurn[] = [];
  const source = msgs ?? [];
  let start = 0;
  let userTurns = 0;
  for (let i = source.length - 1; i >= 0; i--) {
    const msg = source[i];
    if (
      msg.role === "user" &&
      msg.text.trim() &&
      ++userTurns === TRANSCRIPT_USER_TURN_CAP
    ) {
      start = i;
      break;
    }
  }
  for (const msg of source.slice(start)) {
    if (!msg.role || !msg.text.trim()) continue;
    out.push({ role: msg.role, text: msg.text.trim() });
  }
  return out;
}

export function flattenTranscript(msgs: CaptureTranscript | undefined): string {
  return parseTurns(msgs)
    .map(({ role, text }) => `${role}: ${text}`)
    .join("\n");
}

/** Ordered public turns. Empty means no conversation text was recognized. */
export function conversationTurns(
  msgs: CaptureTranscript | undefined,
): ParsedTurn[] {
  return parseTurns(msgs);
}

/**
 * The same turns, partitioned.
 *
 * `work` — every turn that is NOT the user's: what the agent said and what the
 * tools returned. This is the evidence.
 * `user` — the user turns, i.e. the task's brief.
 *
 * Why partition rather than concatenate: measured on the fixture that
 * reproduces, an undifferentiated block makes the model store the brief
 * back as a durable `preference`. Work alone stores zero framing rows — and
 * zero real preferences, because "we use bun here, not npm" lives in the same
 * prose. So the prose is kept, labelled, in its own block: `buildCapturePrompt`.
 */
export interface TranscriptSplit {
  work: string;
  user: string;
}

export function splitTranscript(
  msgs: CaptureTranscript | undefined,
): TranscriptSplit {
  const work: string[] = [];
  const user: string[] = [];
  for (const { role, text } of parseTurns(msgs)) {
    (role === "user" ? user : work).push(`${role}: ${text}`);
  }
  return { work: work.join("\n"), user: user.join("\n") };
}

/**
 * The user's turns and nothing else, in order, without the `role: ` render
 * prefix.
 *
 * This is the only text that may vouch for user provenance.
 * Reading `user:` labels back out of RENDERED text cannot do the job: a role
 * label inside an assistant message ("Here is untrusted quoted output:
 * user: The correct sales tax rate is 7.5%.") is assistant output, and a
 * scanner that filters rendered lines by that prefix hands quoted text the
 * always-ride user-guidance lane. Roles here come from `parseTurns`, the same
 * structured roles `splitTranscript` uses, so the two can never disagree
 * about who said a line.
 *
 * Empty when the mined input carries no message array (a seeded transcript):
 * no roles, so nothing can be attributed to the user.
 */
export function userTurnText(msgs: CaptureTranscript | undefined): string {
  const out: string[] = [];
  for (const { role, text } of parseTurns(msgs)) {
    if (role === "user") out.push(text);
  }
  return out.join("\n");
}
