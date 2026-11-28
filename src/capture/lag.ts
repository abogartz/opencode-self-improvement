import type { CaptureTranscript } from "../host/capture.ts";

/** Age of the newest message in this window, or null without a timestamp. */
export function lagSince(
  messages: CaptureTranscript | undefined,
  now = Date.now(),
): number | null {
  let newest = 0;
  for (const message of messages ?? []) {
    const ms = message.timestamp;
    if (ms !== undefined && Number.isFinite(ms) && ms > newest) newest = ms;
  }
  return newest ? now - newest : null;
}
