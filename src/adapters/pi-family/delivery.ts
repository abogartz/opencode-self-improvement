import type { ObservedToolResult } from "../../host/lifecycle.ts";
export type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Return replacement content without changing the event or losing image blocks. */
export function appendPull(
  content: readonly PiContent[],
  before: string,
  after: string,
): PiContent[] | undefined {
  if (!after.startsWith(before)) return undefined;
  const suffix = after.slice(before.length);
  if (!suffix) return undefined;
  const next = [...content];
  for (let i = next.length - 1; i >= 0; i--) {
    const part = next[i]!;
    if (part.type === "text") {
      next[i] = { ...part, text: part.text + suffix };
      return next;
    }
  }
  next.push({ type: "text", text: suffix });
  return next;
}

/** Context-stage observations; later context or provider hooks remain opaque. */
export function observedToolResults(
  messages: readonly unknown[],
): ObservedToolResult[] {
  const results: ObservedToolResult[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    if (
      msg.role !== "toolResult" ||
      typeof msg.toolCallId !== "string" ||
      typeof msg.toolName !== "string"
    )
      continue;
    results.push({
      callID: msg.toolCallId,
      tool: msg.toolName,
      text: textContent(msg.content),
    });
  }
  return results;
}
