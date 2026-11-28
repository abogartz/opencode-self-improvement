import type { ObservedToolResult } from "../../host/lifecycle.ts";

// Put the pull onto the host's tool result so the model actually reads it.
// WHICH field the host forwards is measured, not assumed. On opencode v2.3.0
// (probed through e2e/support/harness.ts against the real host) `result.content`
// is an ARRAY of `{type:"text",text}` parts and mutating a text part changes the
// next request; mutating `result.output` — the file-attachment object
// `{type,uri,name,content,encoding,mime}` — does not. Older hosts passed a plain
// string in `content`, which is the shape this function was originally written
// against, and a string `output` is covered too.
//
// Returns true only when the bytes were placed. A pull that found nowhere to
// write showed the model nothing. Placement is still not delivery: a later
// plugin's hook can trim the result, so the caller only HOLDS the credit and
// the next request settles it (src/inject/pull-receipts.ts).
export function writePullIntoResult(
  result: unknown,
  before: string,
  after: string,
): boolean {
  if (!result || typeof result !== "object") return false;
  // Compare the two local strings to isolate the suffix this hook appended.
  if (!after.startsWith(before)) return false;
  const block = after.slice(before.length);
  if (!block) return false;
  const r = result as { content?: unknown };
  if (typeof r.content === "string") {
    r.content += block;
    return true;
  }
  if (Array.isArray(r.content)) {
    // Append to the LAST text part: the pull is commentary on the output, so it
    // belongs after it, and a result can carry several parts.
    for (let i = r.content.length - 1; i >= 0; i--) {
      const part = r.content[i] as { text?: unknown } | undefined;
      if (part && typeof part === "object" && typeof part.text === "string") {
        part.text += block;
        return true;
      }
    }
    r.content.push({ type: "text", text: block });
    return true;
  }
  return false;
}

// Best-effort extraction of a tool's textual output + metadata from the V2
// execute.after `result` payload, whose exact encoding varies by tool.
export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  for (const k of ["output", "text", "content", "stdout"]) {
    const v = r[k];
    if (typeof v === "string") return v;
  }
  if (Array.isArray(r.content)) {
    return (r.content as Array<Record<string, unknown>>)
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
export function resultMeta(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object") {
    const m = (result as Record<string, unknown>).metadata;
    if (m && typeof m === "object") return m as Record<string, unknown>;
  }
  return {};
}

function observedText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return undefined;
  const r = result as { type?: unknown; value?: unknown };
  if ((r.type === "text" || r.type === "error") && typeof r.value === "string")
    return r.value;
  if (r.type === "content" && Array.isArray(r.value)) {
    return r.value
      .map((p) =>
        p?.type === "text" && typeof p.text === "string" ? p.text : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

/** Decode only actual tool-result parts; user and assistant quotations do not count. */
export function observedToolResults(messages: unknown): ObservedToolResult[] {
  const results: ObservedToolResult[] = [];
  if (!Array.isArray(messages)) return results;
  for (const msg of messages) {
    if (msg?.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        part?.type !== "tool-result" ||
        typeof part.id !== "string" ||
        typeof part.name !== "string"
      )
        continue;
      results.push({
        callID: part.id,
        tool: part.name,
        text: observedText(part.result) ?? "",
      });
    }
  }
  return results;
}
