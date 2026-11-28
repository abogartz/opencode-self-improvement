import type { SessionUsage } from "../../host/observations.ts";
interface HistoryContext {
  sessionManager: { getSessionId(): string; getEntries?(): readonly unknown[] };
}

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Finalized assistant history only; streaming and auxiliary model calls are excluded. */
export function sessionUsage(
  ctx: HistoryContext,
  sessionID: string,
  reasoningField = "reasoningTokens",
): SessionUsage | undefined {
  try {
    const entries = ctx.sessionManager.getEntries?.();
    if (!Array.isArray(entries)) return;
    let input = 0,
      read = 0,
      write = 0,
      output = 0,
      reasoning = 0,
      receipts = 0;
    let split = true;
    for (const raw of entries) {
      const entry = fields(raw);
      const message = fields(entry.message);
      if (entry.type !== "message" || message.role !== "assistant") continue;
      const u = fields(message.usage);
      if (
        !count(u.input) ||
        !count(u.cacheRead) ||
        !count(u.cacheWrite) ||
        !count(u.output)
      )
        continue;
      // Pi persists an empty assistant on a pre-request abort. It carries no
      // usage and must not erase the reasoning split of earlier real receipts.
      if (
        (message.stopReason === "aborted" || message.stopReason === "error") &&
        u.input + u.cacheRead + u.cacheWrite + u.output === 0
      )
        continue;
      if (
        u[reasoningField] !== undefined &&
        (!count(u[reasoningField]) || u[reasoningField] > u.output)
      )
        continue;
      receipts++;
      input += u.input;
      read += u.cacheRead;
      write += u.cacheWrite;
      output += u.output;
      if (u[reasoningField] === undefined) split = false;
      else reasoning += u[reasoningField] as number;
    }
    if (!receipts || ![input, read, write, output, reasoning].every(count))
      return;
    return {
      sessionID,
      accountingID: ctx.sessionManager.getSessionId(),
      cumulative: true,
      input,
      read,
      write,
      output: split ? output - reasoning : output,
      reasoning: split ? reasoning : undefined,
    };
  } catch {
    // An unavailable history must not break the user's session or imply zero use.
    return;
  }
}
