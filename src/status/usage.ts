import type { Measured } from "./payload.ts";
import type { SessionUsage } from "../host/observations.ts";
import { currentHarness } from "../telemetry/harness.ts";

// Streaming receipts replace one message; cumulative receipts replace the session.
const messageReceipts = new Map<string, Map<string, Measured>>();

/** Fold one usage receipt into the session's measured total. */
export function foldUsage(usage: SessionUsage, at: string): Measured {
  const receipt: Measured = {
    at,
    input: usage.input,
    read: usage.read,
    write: usage.write,
    output: usage.output,
    reasoning: usage.reasoning,
  };
  if (usage.cumulative || usage.messageID === undefined) return receipt;
  const key = `${currentHarness()}\0${usage.sessionID}`;
  let msgs = messageReceipts.get(key);
  if (!msgs) {
    msgs = new Map();
    messageReceipts.set(key, msgs);
  }
  msgs.set(usage.messageID, receipt);
  const total = {
    at,
    input: 0,
    read: 0,
    write: 0,
    output: 0,
    reasoning: 0 as number | undefined,
  };
  let split = true;
  let reportedReasoning = 0;
  for (const r of msgs.values()) {
    total.input += r.input ?? 0;
    total.read += r.read ?? 0;
    total.write += r.write ?? 0;
    total.output += r.output ?? 0;
    if (r.reasoning === undefined) split = false;
    else reportedReasoning += r.reasoning;
    if (r.at > total.at) total.at = r.at;
  }
  total.reasoning = split ? reportedReasoning : undefined;
  if (!split) total.output += reportedReasoning;
  return total;
}

/** Drop a session's per-message ledger when its status entry is evicted. */
export function forgetUsage(sessionID: string): void {
  messageReceipts.delete(`${currentHarness()}\0${sessionID}`);
}
