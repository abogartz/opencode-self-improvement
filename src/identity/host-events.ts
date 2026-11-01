// Compatibility boundary for host payloads. These adapters only read data;
// repository binding, ambient fallbacks, clocks, and I/O belong to the caller.
function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export interface ToolIdentity {
  sessionID?: string;
  callID?: string;
}

/** V2 ToolContext uses `id` for the call; absent/empty fields need a fallback. */
export function toolIdentity(context: unknown): ToolIdentity {
  const { sessionID, id } = fields(context);
  return {
    sessionID: typeof sessionID === "string" && sessionID ? sessionID : undefined,
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
export function sessionIdentityEvent(raw: unknown): SessionIdentity | undefined {
  const event = fields(raw);
  if (typeof event.type !== "string" || !IDENTITY_EVENT_TYPES.includes(event.type)) return undefined;
  const data = fields(event.data ?? event.properties);
  const info = fields(data.info ?? data);
  const sessionID = info.sessionID ?? data.sessionID;
  const directory = fields(info.location).directory ?? fields(data.location).directory
    ?? fields(event.location).directory ?? info.directory;
  if (typeof sessionID !== "string") return undefined;
  return { sessionID, directory: typeof directory === "string" ? directory : undefined };
}

/** Legacy context messages sometimes carry location directly or inside info. */
export function sessionDirectoryFromMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    const row = fields(message);
    const directory = fields(row.location).directory ?? fields(fields(row.info).location).directory;
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
}

/** V2 session usage, or the assistant-message usage emitted by older hosts. */
export function sessionUsageEvent(raw: unknown): SessionUsage | undefined {
  const event = fields(raw);
  let info: Record<string, unknown>;
  if (event.type === "session.usage.updated") {
    info = fields(event.data);
  } else if (event.type === "message.updated") {
    info = fields(fields(event.properties).info ?? event.info ?? fields(event.data).info);
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
  };
}

/** Session ID envelopes accepted by capture; trigger selection stays separate. */
export function captureSessionID(raw: unknown): string | undefined {
  const event = fields(raw);
  const sessionID = fields(event.data).sessionID ?? event.sessionID ?? fields(event.properties).sessionID;
  return typeof sessionID === "string" ? sessionID : undefined;
}
