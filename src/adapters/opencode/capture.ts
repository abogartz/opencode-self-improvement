import type { MemoryCaptureHost } from "../../host/capture.ts";
import type { PluginCtx } from "./context.ts";
import { captureSessionID } from "./observations.ts";
import { decodeTranscript } from "./transcript.ts";

// ---- capture trigger vocabulary -------------------------------------
// Single source of truth for capture subscriptions. Both turn-end events were
// observed on the desktop service (test/fixtures/host-events.jsonl).
// test/identity/event-fidelity.test.ts requires every trigger to appear in both that
// recording and the installed @opencode/schema manifest: a declared event
// alone is insufficient evidence that the host emits it.
// Identity triggers have a separate observed check in that test, combining
// this recording with the 2.2.2 move extract in host-session-move.json.
export const TURN_END_EVENTS = [
  "session.execution.succeeded",
  "session.execution.interrupted",
] as const;

/** Every event type the capture subscription reacts to (fidelity-tested). */
export const CAPTURE_EVENT_TYPES: readonly string[] = [...TURN_END_EVENTS];

// `session.idle`, `session.status`, and `session.execution.failed` are declared
// but absent from that recording, so they deliberately do not trigger capture.
// Adding a trigger requires a recording; status would also need idle filtering.

/**
 * True when a host event means "this session just went quiet". The internal
 * trigger name stays "idle" (cooldown keys, `auto_capture_*` evidence lines and
 * the historical idle-vs-compaction bench all use it).
 */
export function captureTriggerFor(event: unknown): boolean {
  const type = (event as { type?: unknown } | null)?.type;
  return (
    typeof type === "string" &&
    (TURN_END_EVENTS as readonly string[]).includes(type)
  );
}

export function createOpenCodeCapture(ctx: PluginCtx): MemoryCaptureHost {
  const eventApi = ctx.event;
  const generateApi = ctx.generate;
  return {
    subscribedEvents: CAPTURE_EVENT_TYPES,
    capabilityLabels: {
      turnEndEvents: "event.subscribe",
      generateText: "generate.text",
      readTranscript: "session.context",
    },
    turnEndEvents: eventApi?.subscribe
      ? async function* (signal) {
          for await (const raw of eventApi.subscribe({ signal })) {
            if (signal.aborted) break;
            if (captureTriggerFor(raw))
              yield { sessionID: captureSessionID(raw) };
          }
        }
      : undefined,
    readTranscript: ctx.session?.context
      ? async (sessionID) =>
          decodeTranscript(await ctx.session?.context?.({ sessionID }))
      : undefined,
    generateText: generateApi?.text
      ? async (input) => {
          input.signal.throwIfAborted();
          const out = await generateApi.text(
            {
              model: input.model,
              prompt: input.prompt,
            },
            { signal: input.signal },
          );
          return typeof out === "string" ? out : (out?.text ?? "");
        }
      : undefined,
    defaultModel: async () => {
      const api = ctx.model?.default;
      const d =
        typeof api === "function"
          ? (
              await api.call(ctx.model, {
                location: { directory: ctx.location?.directory },
              })
            ).data
          : api?.get?.();
      return d &&
        typeof d.providerID === "string" &&
        d.providerID &&
        typeof d.modelID === "string" &&
        d.modelID
        ? { providerID: d.providerID, id: d.modelID }
        : null;
    },
  };
}
