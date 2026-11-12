// Compatibility boundary for host payloads. These adapters only read data;
// repository binding, ambient fallbacks, clocks, and I/O belong to the caller.
import type { Measured } from "../status/payload.ts";

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export interface ToolIdentity {
  sessionID?: string;
  callID?: string;
}

/** V2 ToolContext uses `id` for the call; absent/empty fields need a fallback. */
export function toolIdentity(context: unknown): ToolIdentity {
  const { sessionID, id } = fields(context);
  return {
    sessionID:
      typeof sessionID === "string" && sessionID ? sessionID : undefined,
    callID: typeof id === "string" && id ? id : undefined,
  };
}

export interface SessionIdentity {
  sessionID: string;
  directory?: string;
}

// Shared with the recording-backed fidelity checks. Adding a trigger requires
// both a protocol declaration and an observation from a live host.
export const IDENTITY_EVENT_TYPES: readonly string[] = Object.freeze([
  "session.created",
  "session.execution.started",
  "session.moved",
]);

/** A directory-less identity still lets the caller resolve the session row. */
export function sessionIdentityEvent(
  raw: unknown,
): SessionIdentity | undefined {
  const event = fields(raw);
  if (
    typeof event.type !== "string" ||
    !IDENTITY_EVENT_TYPES.includes(event.type)
  )
    return undefined;
  const data = fields(event.data ?? event.properties);
  const info = fields(data.info ?? data);
  const sessionID = info.sessionID ?? data.sessionID;
  const directory =
    fields(info.location).directory ??
    fields(data.location).directory ??
    fields(event.location).directory ??
    info.directory;
  if (typeof sessionID !== "string") return undefined;
  return {
    sessionID,
    directory: typeof directory === "string" ? directory : undefined,
  };
}

/** Legacy context messages sometimes carry location directly or inside info. */
export function sessionDirectoryFromMessages(
  messages: unknown,
): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    const row = fields(message);
    const directory =
      fields(row.location).directory ??
      fields(fields(row.info).location).directory;
    if (typeof directory === "string" && directory) return directory;
  }
  return undefined;
}

/** session.get returns either a row or a {data: row} response. */
export function sessionDirectoryFromRow(result: unknown): string | undefined {
  const response = fields(result);
  const row = fields(response.data ?? response);
  const directory = fields(row.location).directory ?? row.directory;
  return typeof directory === "string" && directory ? directory : undefined;
}

export interface SessionUsage {
  sessionID: string;
  input: number;
  read: number;
  write: number;
  /**
   * Completion tokens the session generated (#387). Absent from the envelope
   * before this, so the plugin could report what the prompt cache cost but
   * never what the session itself produced — and `input` is only the UNCACHED
   * remainder, so the two together understate a session by most of its size.
   * Zero when the host omits the field, which is why the status surface gates
   * its generation line on a nonzero rather than printing 0.
   */
  output: number;
  reasoning: number;
  /**
   * The message this receipt belongs to — the `message.updated` compatibility
   * path only. Streaming updates for the same message overwrite each other;
   * they must not overwrite another message's receipt (#394 review).
   */
  messageID?: string;
  /**
   * True only for `session.usage.updated`: that source is cumulative, so the
   * latest receipt replaces the session total instead of folding into it.
   */
  cumulative?: boolean;
}

/** V2 session usage, or the assistant-message usage emitted by older hosts. */
export function sessionUsageEvent(raw: unknown): SessionUsage | undefined {
  const event = fields(raw);
  let info: Record<string, unknown>;
  if (event.type === "session.usage.updated") {
    info = fields(event.data);
  } else if (event.type === "message.updated") {
    info = fields(
      fields(event.properties).info ?? event.info ?? fields(event.data).info,
    );
    if (info.role !== "assistant") return undefined;
  } else {
    return undefined;
  }
  if (typeof info.sessionID !== "string" || !info.tokens) return undefined;
  const tokens = fields(info.tokens);
  const cache = fields(tokens.cache);
  return {
    sessionID: info.sessionID,
    input: Number(tokens.input) || 0,
    read: Number(cache.read) || 0,
    write: Number(cache.write) || 0,
    output: Number(tokens.output) || 0,
    reasoning: Number(tokens.reasoning) || 0,
    // The two sources mean different things, and conflating them was the
    // review finding: `session.usage.updated` is cumulative, so its latest
    // receipt IS the session total; `message.updated` carries ONE message's
    // usage, and the total must sum across messages.
    ...(event.type === "session.usage.updated" ? { cumulative: true } : {}),
    ...(typeof info.id === "string" ? { messageID: info.id } : {}),
  };
}

// #394 review: on the `message.updated` compatibility path each receipt is
// ONE message's usage, not the session's. Overwriting the session total with
// the last message displayed 90 completion tok where two messages produced
// 160. Streaming updates arrive repeatedly per message, so the latest receipt
// per message is kept and the session total sums across messages. A
// genuinely cumulative `session.usage.updated` keeps its replacement
// semantics. State is module-level and evicted with the session (the epoch
// controller's LRU calls forgetUsage).
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
  let msgs = messageReceipts.get(usage.sessionID);
  if (!msgs) {
    msgs = new Map();
    messageReceipts.set(usage.sessionID, msgs);
  }
  msgs.set(usage.messageID, receipt);
  const total = {
    at,
    input: 0,
    read: 0,
    write: 0,
    output: 0,
    reasoning: 0,
  };
  for (const r of msgs.values()) {
    total.input += r.input ?? 0;
    total.read += r.read ?? 0;
    total.write += r.write ?? 0;
    total.output += r.output ?? 0;
    total.reasoning += r.reasoning ?? 0;
    if (r.at > total.at) total.at = r.at;
  }
  return total;
}

/** Drop a session's per-message ledger when its status entry is evicted. */
export function forgetUsage(sessionID: string): void {
  messageReceipts.delete(sessionID);
}

/** Session ID envelopes accepted by capture; trigger selection stays separate. */
export function captureSessionID(raw: unknown): string | undefined {
  const event = fields(raw);
  const sessionID =
    fields(event.data).sessionID ??
    event.sessionID ??
    fields(event.properties).sessionID;
  return typeof sessionID === "string" ? sessionID : undefined;
}
