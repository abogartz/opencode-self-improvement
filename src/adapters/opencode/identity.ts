import type { ToolCallContext } from "../../host/contracts.ts";

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** V2 ToolContext uses id for the call; missing fields retain the legacy fallback. */
export function toolIdentity(context: unknown): ToolCallContext {
  const { sessionID, id } = fields(context);
  return {
    sessionID:
      typeof sessionID === "string" && sessionID ? sessionID : undefined,
    callID: typeof id === "string" && id ? id : undefined,
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
