import type { CaptureMessage, CaptureTranscript } from "../../host/capture.ts";

/** Public text only. Every source message keeps its cursor slot. */
export function decodeTranscript(
  messages: readonly unknown[],
): CaptureTranscript {
  return messages.map((value): CaptureMessage => {
    if (!value || typeof value !== "object") return { text: "" };
    const message = value as Record<string, unknown>;
    const role = message.role;
    if (
      (role !== "user" && role !== "assistant") ||
      (role === "user" && message.attribution === "agent")
    )
      return { text: "" };
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (part) =>
                  part && part.type === "text" && typeof part.text === "string",
              )
              .map((part) => part.text)
              .join("\n")
          : "";
    return {
      role,
      text: text.trim(),
      ...(typeof message.timestamp === "number" &&
      Number.isFinite(message.timestamp)
        ? { timestamp: message.timestamp }
        : {}),
    };
  });
}
