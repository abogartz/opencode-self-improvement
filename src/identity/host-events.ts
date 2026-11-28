import type { SessionIdentity, SessionUsage } from "../host/observations.ts";

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
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

/** Session ID envelopes accepted by capture; trigger selection stays separate. */
export function captureSessionID(raw: unknown): string | undefined {
  const event = fields(raw);
  const sessionID =
    fields(event.data).sessionID ??
    event.sessionID ??
    fields(event.properties).sessionID;
  return typeof sessionID === "string" ? sessionID : undefined;
}
