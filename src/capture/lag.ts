// lag — split from src/capture.ts (#168 domain restructure). Declaration bodies are unchanged.


/**
 * Age of the newest message in a session context, in ms, or null when no
 * message carries a timestamp. Capture uses this to say how stale a transcript
 * was at the moment the model was asked for candidates (#44).
 */
export function lagSince(messages: unknown, now = Date.now()): number | null {
  let newest = 0;
  for (const raw of Array.isArray(messages) ? messages : []) {
    const m = raw as Record<string, any>;
    const at = m?.time?.updated ?? m?.createdAt ?? m?.created ?? m?.timestamp;
    const ms = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : Number.NaN;
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }
  return newest ? now - newest : null;
}
