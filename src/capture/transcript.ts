// transcript — split from src/capture.ts (#168 domain restructure). Declaration bodies are unchanged.


// Render an array of session-context messages of unknown shape into
// "role: text" lines. Defensive by construction (the API shape varies and is
// not ours to trust): non-arrays and junk entries are skipped; role comes
// from info.role | role, text from parts[].text | text | content (strings
// only); capped at 40 user turns. Never throws.
const TRANSCRIPT_USER_TURN_CAP = 40;

export function flattenTranscript(msgs: unknown): string {
  try {
    if (!Array.isArray(msgs)) return "";
    const lines: string[] = [];
    let userTurns = 0;
    for (const msg of msgs) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const info =
        m.info && typeof m.info === "object" ? (m.info as Record<string, unknown>) : undefined;
      const role =
        typeof info?.role === "string" ? info.role : typeof m.role === "string" ? m.role : "";
      let text = "";
      let hadPrivatePart = false;
      if (Array.isArray(m.parts)) {
        text = m.parts
          .map((p) => {
            if (!p || typeof p !== "object") return undefined;
            const part = p as Record<string, unknown>;
            const partType = typeof part.type === "string" ? part.type.toLowerCase() : "";
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
