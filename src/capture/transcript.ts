import type { CaptureMessage, CaptureTranscript } from "../host/capture.ts";

function roleOf(
  m: Record<string, unknown>,
  info: Record<string, unknown> | undefined,
): "user" | "assistant" | undefined {
  for (const v of [info?.role, m.role, m.type])
    if (v === "user" || v === "assistant") return v;
  return undefined;
}

function timestampOf(m: Record<string, any>): number | undefined {
  const at =
    m.time?.updated ??
    m.time?.completed ??
    m.time?.created ??
    m.createdAt ??
    m.created ??
    m.timestamp;
  const ms =
    typeof at === "number"
      ? at
      : typeof at === "string"
        ? Date.parse(at)
        : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** Decode recorded and legacy OpenCode shapes without collapsing cursor positions. */
export function decodeTranscript(raw: unknown): CaptureTranscript | undefined {
  if (!Array.isArray(raw)) return undefined;
  return Array.from(raw, (msg): CaptureMessage => {
    if (!msg || typeof msg !== "object") return { text: "" };
    const m = msg as Record<string, unknown>;
    const info =
      m.info && typeof m.info === "object"
        ? (m.info as Record<string, unknown>)
        : undefined;
    const role = roleOf(m, info);
    let text = "";
    let hadPrivatePart = false;
    // V1 carried parts under `parts`; 2.2.5 carries them under `content`.
    const partList = Array.isArray(m.parts)
      ? m.parts
      : Array.isArray(m.content)
        ? m.content
        : null;
    if (partList) {
      text = partList
        .map((p) => {
          if (!p || typeof p !== "object") return undefined;
          const part = p as Record<string, unknown>;
          const partType =
            typeof part.type === "string" ? part.type.toLowerCase() : "";
          if (partType === "reasoning" || partType === "thinking") {
            hadPrivatePart = true;
            return undefined;
          }
          return part.text;
        })
        .filter((t): t is string => typeof t === "string" && t.length > 0)
        .join(" ");
    }
    if (!text && !hadPrivatePart) {
      for (const k of ["text", "content"]) {
        if (typeof m[k] === "string") {
          text = m[k] as string;
          break;
        }
      }
    }

    const timestamp = timestampOf(m);
    return {
      ...(role ? { role } : {}),
      text: role ? text.trim() : "",
      ...(timestamp !== undefined ? { timestamp } : {}),
    };
  });
}
