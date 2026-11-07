// transcript — split from src/capture.ts (#168 domain restructure). Declaration bodies are unchanged.

// Render an array of session-context messages of unknown shape into
// "role: text" lines. Defensive by construction (the API shape varies and is
// not ours to trust): non-arrays and junk entries are skipped; role comes
// from info.role | role | type, text from parts[].text | content[].text |
// text | content (strings only); capped at 40 user turns. Never throws.
//
// The `type` role source and the `content[]` part array are the 2.2.5 host
// shape, recorded live: `session.context()` returns
// `{id, time, type:"user", text}` and `{id, time, type:"assistant", content:
// [{type:"reasoning"|"tool"|"text", ...}]}` — no `role`, no `parts`. Reading
// only the old keys rendered EVERY 2.2.5 session as a 0-character transcript,
// which the 200-character floor then skipped in silence: auto-capture never
// fired on a live host, and nothing said so.
const TRANSCRIPT_USER_TURN_CAP = 40;

// 2.2.5 also puts NON-conversation records in the same array (`type:"idle"`),
// so only these values are accepted as a role. Anything else renders nothing.
const CONVERSATION_ROLES: readonly string[] = ["user", "assistant"];

function roleOf(
  m: Record<string, unknown>,
  info: Record<string, unknown> | undefined,
): string {
  for (const v of [info?.role, m.role, m.type])
    if (typeof v === "string" && CONVERSATION_ROLES.includes(v)) return v;
  return "";
}

export function flattenTranscript(msgs: unknown): string {
  try {
    if (!Array.isArray(msgs)) return "";
    const lines: string[] = [];
    let userTurns = 0;
    for (const msg of msgs) {
      if (!msg || typeof msg !== "object") continue;
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
      if (!role || !text.trim()) continue;
      if (role === "user") {
        userTurns++;
        if (userTurns > TRANSCRIPT_USER_TURN_CAP) break;
      }
      lines.push(`${role}: ${text.trim()}`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}
