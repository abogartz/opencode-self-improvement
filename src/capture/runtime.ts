// Opt-in capture configuration and dispatch (#168). Cooldowns remain process-wide;
// subscriptions and dispatch closures belong to one setup instance.
import type { Cleanup } from "@opencode/plugin/promise/plugin";
import { setCurrent, session } from "../core/state.ts";
import { record, recordCaptureLag } from "../evidence/record.ts";
import { type GateContext, runWriteGate } from "../gate/gate.ts";
import { captureSessionID } from "../identity/host-events.ts";
import { bindSessionProvisional, writeTarget } from "../identity/repokey.ts";
import { quarantineCandidate } from "../store/quarantine/quarantine.ts";
import { redactSecrets } from "../store/secrets.ts";
import { parseCandidates, parseModelRef } from "./candidates.ts";
import { lagSince } from "./lag.ts";
import { buildCapturePrompt } from "./prompt.ts";
import { type SessionModelRef, sessionModel } from "./session-model.ts";
import { flattenTranscript, splitTranscript } from "./transcript.ts";
import {
  advanceCaptureCursor,
  captureCursor,
  captureSignalSince,
  deltaMessages,
} from "./policy.ts";

interface CaptureHost {
  options?: Record<string, unknown>;
  event?: {
    subscribe: (o?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  };
  generate?: { text: (input: unknown) => Promise<{ text?: string } | string> };
  session?: { context?: (input: { sessionID: string }) => Promise<unknown> };
  // Host default model (#139): the last-resort source for an omitted
  // captureModel. Optional-call everywhere: older/fake hosts expose none.
  model?: {
    default?: {
      get?: () => { providerID: string; modelID: string } | undefined;
    };
  };
}

interface CaptureDependencies {
  instanceDir: string | undefined;
  gateContext: (sid?: string) => GateContext;
  guarded: (name: string, fn: () => Promise<void>) => Promise<void>;
}

// Tag on store rows captured by the COMPACTION trigger (issue #41). Rows keep
// the shared "auto-capture" provenance tag (src/inject.ts renders it) and add
// this one so decay/status can tell which trigger wrote them — the same
// distinction the auto_capture_compaction_* evidence lines carry.
const CAPTURE_COMPACT_TAG = "auto_capture_compaction";

// Auto-capture cooldown, shared by EVERY setup() registration (#108): setup
// runs for more than one location, and per-closure cooldown maps made those
// registrations strangers - one compaction could pay for two model calls on
// one transcript. Same module-level shape as `turns` in src/lock.ts; the key
// names the trigger, so measuring one trigger is still not confounded by the
// other having fired moments ago.
const lastCaptureRun = new Map<string, number>();

const CAPTURE_COOLDOWN_MS = 5 * 60_000;

/** True if this trigger may fire for this session now; records the fire. */
function captureCooldownPasses(
  trigger: "idle" | "compaction",
  sid: string,
  now: number,
): boolean {
  const key = `${trigger}:${sid}`;
  if (now - (lastCaptureRun.get(key) ?? 0) < CAPTURE_COOLDOWN_MS) return false;
  // Sessions churn and a long-lived server must not grow one entry per
  // session forever; oldest-inserted go first (the ledger throttle's rule).
  if (lastCaptureRun.size > 2000) {
    for (const k of [...lastCaptureRun.keys()].slice(0, 1000))
      lastCaptureRun.delete(k);
  }
  lastCaptureRun.set(key, now);
  return true;
}

/** Clear the cooldown windows (tests; also what a process restart does). */
export function resetCaptureCooldowns(): void {
  lastCaptureRun.clear();
}

// ---- capture trigger vocabulary (#136) -------------------------------------
// Single source of truth for capture subscriptions. Both turn-end events were
// observed on the desktop service (test/fixtures/host-events.jsonl).
// test/event-fidelity.test.ts requires every trigger to appear in both that
// recording and the installed @opencode/schema manifest: a declared event
// alone is insufficient evidence that the host emits it (#78, #136).
// Identity triggers have a separate observed check in that test, combining
// this recording with the 2.2.2 move extract in host-session-move.json (#176).
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

export function configureAutoCapture(
  ctx: CaptureHost,
  { instanceDir, gateContext, guarded }: CaptureDependencies,
) {
  let onCompactCapture: ((sid: string, messages: unknown) => void) | undefined;
  let captureCleanup: Cleanup | undefined;
  if (ctx.options?.autoCapture === true) {
    const captureModelOpt = ctx.options.captureModel;
    // #139: an OMITTED captureModel no longer disables the subscription. It
    // resolves per capture — the per-session ref last seen on session.context,
    // else the host default — and only when both are missing does the pass
    // skip. autoCapture:true is already the explicit opt-in; a second required
    // config string was a syntax tax whose failure mode was a console.warn
    // nobody reads. An explicit but INVALID captureModel keeps today's
    // fail-closed setup behaviour: silently substituting another model than
    // the one the user typed is worse than the tax it replaces.
    const omitted = captureModelOpt === undefined;
    const captureMax = Number(ctx.options.captureMax) || 3;
    const captureOnCompact = ctx.options?.captureOnCompact !== false;
    // #334: two cost levers, both OFF by default until the benchmark says which
    // way to set them. `captureOnSignal` skips a capture whose turn produced
    // nothing durable; `captureDelta` mines only the turns since the last
    // capture instead of re-reading the whole session every time.
    const captureOnSignal = ctx.options?.captureOnSignal === true;
    const captureDelta = ctx.options?.captureDelta === true;
    const modelRef = omitted ? null : parseModelRef(captureModelOpt);
    if (!omitted && !modelRef) {
      // Invalid explicit model: skip registering the whole subscription
      // rather than guess (and warn once, at setup).
      console.warn(
        `[opencode-self-improvement] autoCapture is on but captureModel ${JSON.stringify(captureModelOpt)} is invalid (expected "provider/id"); auto-capture disabled.`,
      );
    } else if (
      !ctx.event?.subscribe ||
      !ctx.generate?.text ||
      !ctx.session?.context
    ) {
      console.warn(
        "[opencode-self-improvement] autoCapture is on but this OpenCode context lacks event.subscribe/generate.text/session.context; auto-capture disabled.",
      );
    } else {
      const controller = new AbortController();
      const eventApi = ctx.event;
      const generateApi = ctx.generate;
      // Arrow wrapper: keep the receiver bound. The harness fakes are closures,
      // but a real client method that reads `this` would break if detached —
      // and the fail-closed catch below would hide it. Optional call: the
      // setup guard proves it exists, but property narrowing does not survive
      // into the closure, and undefined degrades safely (empty transcript).
      const contextFn = (input: { sessionID: string }) =>
        ctx.session?.context?.(input);

      // #139 model resolution: explicit option (captured above) wins; else the
      // ref this session's context hook last carried; else the host default.
      // Warn-once per setup when even the last resort is empty — a per-event
      // warn would spam the log for every turn of a model-less session.
      let warnedNoModel = false;
      const hostDefault = (): SessionModelRef | null => {
        const d = ctx.model?.default?.get?.();
        if (
          d &&
          typeof d.providerID === "string" &&
          d.providerID &&
          typeof d.modelID === "string" &&
          d.modelID
        )
          return { providerID: d.providerID, id: d.modelID };
        return null;
      };

      // ONE capture pass, shared by both triggers. `seeded` is a transcript
      // already in hand — the compaction hook carries the PRE-compaction
      // messages, which is the whole point (Compaction Cliff: one round
      // retains 53% of exact-wording rules); when it is absent (older host
      // shapes) or too thin, the session context is read instead, the same
      // source the idle trigger mines.
      async function captureSession(
        sid: string,
        seeded: string,
        trigger: "idle" | "compaction",
        seededMsgs?: unknown,
      ): Promise<void> {
        // Bind the capturing session for the synchronous stretches of this
        // path - but NOT as a promise: the awaits below let another session
        // move current, so the gate context and the persisted rows thread
        // `sid` explicitly instead of reading it back from the global (#116).
        setCurrent({ sessionID: sid });
        // The capture's dedup reads and the rows it writes partition by the
        // CAPTURED session's repository — an unbound sid would otherwise
        // read global-only and mine duplicates into the store (#127; in
        // production the prompt hook already bound it firmly, so this is a
        // no-op there). SYNC only: a lookup call here would break the
        // zero-token promise of the capture tests.
        bindSessionProvisional(sid, instanceDir);
        const captureGate = gateContext(sid);
        // #139: resolve the model BEFORE any skip so every capture evidence
        // line below can carry model= (cost attributable to a named model —
        // the real answer to the cost-surprise concern that justified the
        // required captureModel). Resolution itself is token-free.
        const model = modelRef ?? sessionModel(sid) ?? hostDefault();
        const modelTag = model ? `${model.providerID}/${model.id}` : undefined;
        // #152: an instance with no workspace cannot say which repository the
        // mined rows belong to, and rows with no owner are exactly what the
        // store refuses. Skip BEFORE the model call — no tokens spent on a
        // capture that cannot be stored — and leave the reason in evidence.
        if (!writeTarget(sid).ok) {
          await record(
            "auto_capture_refused",
            { session: sid, trigger, ...(modelTag ? { model: modelTag } : {}) },
            true,
            sid,
            captureGate.evidenceContext,
          );
          return;
        }
        if (!model) {
          // Both inheritance sources empty: today's last resort, warn + skip.
          if (!warnedNoModel) {
            warnedNoModel = true;
            console.warn(
              "[opencode-self-improvement] autoCapture is on but captureModel is omitted and neither session.context nor the host default names a model; capture skipped (warned once).",
            );
          }
          await record(
            "auto_capture_refused",
            { session: sid, trigger, reason: "no_model" },
            true,
            sid,
            captureGate.evidenceContext,
          );
          return;
        }
        // #334: the signal gate runs BEFORE the context read. Its whole point
        // is to not pay for this capture, so checking it after fetching the
        // transcript would only save the model call and not the read.
        const cursor = captureCursor(sid);
        if (captureOnSignal) {
          const verdict = captureSignalSince(session(sid), cursor.turn);
          if (!verdict.ok) {
            await record(
              "auto_capture_skipped",
              {
                session: sid,
                trigger,
                reason: verdict.why,
                since_turn: cursor.turn,
                ...(modelTag ? { model: modelTag } : {}),
              },
              true,
              sid,
              captureGate.evidenceContext,
            );
            return; // nothing durable this window; the cursor does NOT advance
          }
        }
        let transcript = seeded;
        let msgs = seededMsgs;
        if (transcript.length < 200) {
          msgs = await contextFn({ sessionID: sid });
          transcript = flattenTranscript(msgs);
          // #334: mine only what has not been mined. A seeded compaction
          // payload is the pre-compaction window the hook deliberately handed
          // over (the Compaction Cliff: one round retains 53% of exact-wording
          // rules), so it is mined whole and the cursor is not consulted.
          if (captureDelta) {
            const before = msgs;
            msgs = deltaMessages(msgs, cursor.msgs);
            if (msgs !== before) transcript = flattenTranscript(msgs);
          }
        }
        if (transcript.length < 200) {
          // This return used to be silent, and that silence is why a dead
          // auto-capture looked like a working one: "the transcript was too
          // thin to mine" and "the host never emitted the event" produced
          // byte-identical stores. Record the skip with its size so the two
          // are distinguishable from the evidence file alone.
          await record(
            "auto_capture_skipped",
            {
              session: sid,
              trigger,
              reason: "transcript_too_thin",
              chars: transcript.length,
              ...(modelTag ? { model: modelTag } : {}),
            },
            true,
            sid,
            captureGate.evidenceContext,
          );
          return; // too thin to mine reliably
        }
        // #44: how stale is a capture? Distance from the newest message of
        // the mined transcript to this instant - measured on whatever the
        // trigger actually mined (the hook payload for compaction, the
        // session context for idle), so both triggers' lag is comparable.
        const lagMs = lagSince(msgs);
        // #333: partition what was mined, so the user's brief is labelled as
        // the brief instead of blending into the evidence. Falls back to the
        // single un-partitioned block when the work lines alone are too thin
        // (a seeded transcript with no message array behind it), which keeps
        // the old prompt shape rather than silently dropping the prose.
        const split = splitTranscript(msgs);
        const partitioned = split.work.length >= 200;
        const work = partitioned ? split.work : transcript;
        const userProse = partitioned ? split.user : "";
        const out = await generateApi.text({
          model,
          // Redact the COMPLETE transcript, THEN apply the character budget
          // (#132). Cropping first can start the window INSIDE a credential:
          // a PEM body whose BEGIN marker fell off, or a token whose prefix
          // fell off, matches no pattern — buildCapturePrompt's own scrub
          // (kept, defense in depth) cannot recognize a fragment.
          prompt: buildCapturePrompt(
            redactSecrets(work).slice(-7000),
            captureMax,
            redactSecrets(userProse).slice(-1500),
          ),
        });
        const text = typeof out === "string" ? out : (out?.text ?? "");
        const candidates = parseCandidates(text, captureMax);
        for (const c of candidates) {
          const durable: string[] = [];
          let outcome: Awaited<ReturnType<typeof runWriteGate>>;
          try {
            outcome = await runWriteGate(
              quarantineCandidate({
                ...c,
                tags:
                  trigger === "compaction"
                    ? ["auto-capture", CAPTURE_COMPACT_TAG]
                    : ["auto-capture"],
              }),
              { ...captureGate, durable },
            );
          } catch (err) {
            // A refused write must not disappear into the hook's fail-soft
            // wrapper. Preserve any earlier gate retirements in the receipt.
            await record(
              durable.length ? "auto_capture_partial" : "auto_capture_refused",
              {
                session: sid,
                trigger,
                type: c.type,
                scope: redactSecrets(c.scope),
                reason: String(err),
                retired: durable.join(",") || undefined,
                model: modelTag,
              },
              false,
              sid,
              captureGate.evidenceContext,
            );
            continue;
          }
          await record(
            trigger === "compaction"
              ? `auto_capture_compaction_${outcome.action}`
              : `auto_capture_${outcome.action}`,
            // A blocked credential-shaped scope must not reach the evidence log either.
            // The promoted line also carries the audit fault when the
            // write_promoted line fell (#155 review — capture has no
            // reply to caveat, so this line is the trail's only note).
            {
              session: sid,
              trigger,
              type: c.type,
              scope: redactSecrets(c.scope),
              reason: outcome.reason ?? "",
              audit_error: outcome.evidenceError,
              model: modelTag,
            },
            false,
            sid,
            captureGate.evidenceContext,
          );
        }
        await recordCaptureLag(
          sid,
          lagMs,
          candidates.length ? "candidates" : "empty",
          captureGate.evidenceContext,
          modelTag,
        );
        // #334: the window is consumed. Advance when a capture RAN, whatever it
        // found — zero candidates is an answer, and re-mining an answered
        // window every turn is precisely the cost this cursor exists to remove.
        // A skip returns early and leaves the cursor where it was, so the next
        // signal-bearing turn still mines everything since the last real pass.
        if (captureDelta || captureOnSignal) {
          const total = Array.isArray(msgs)
            ? captureDelta && cursor.msgs > 0
              ? cursor.msgs + msgs.length
              : msgs.length
            : cursor.msgs;
          advanceCaptureCursor(sid, total, session(sid).turns);
        }
      }

      void (async () => {
        try {
          for await (const raw of eventApi.subscribe({
            signal: controller.signal,
          })) {
            if (!captureTriggerFor(raw)) continue;
            const sid = captureSessionID(raw);
            if (sid === undefined) continue;
            setCurrent({ sessionID: sid });
            const now = Date.now();
            if (!captureCooldownPasses("idle", sid, now)) continue; // 5-min cooldown, shared across setups
            try {
              await captureSession(sid, "", "idle");
            } catch (err) {
              // Fail-closed for the SESSION, never silent in the store: the
              // same silence that hid the 2.2.5 shape break would make a
              // throwing capture indistinguishable from one that never ran.
              await record(
                "auto_capture_refused",
                {
                  session: sid,
                  trigger: "idle",
                  reason: "capture_threw",
                  error: redactSecrets(
                    String((err as Error)?.message ?? err),
                  ).slice(0, 200),
                },
                true,
                sid,
                undefined,
              );
            }
          }
        } catch {
          // the subscription itself ended (abort or host error); nothing to do
        }
      })();
      captureCleanup = () => controller.abort();

      // The compaction trigger needs no extra subscription: the session
      // compaction hook (registered above) calls through this seam. The
      // cooldown names the trigger, so measuring a compaction capture is
      // not confounded by an idle fire moments before - and lives at
      // module level, so a second setup() cannot double-pay one
      // compaction (#108).
      if (captureOnCompact) {
        onCompactCapture = (sid, messages) => {
          if (controller.signal.aborted) return;
          const now = Date.now();
          if (!captureCooldownPasses("compaction", sid, now)) return; // 5-min cooldown
          void guarded("session.compaction (auto-capture)", () =>
            captureSession(
              sid,
              flattenTranscript(messages),
              "compaction",
              messages,
            ),
          );
        };
      }
    }
  } else if (ctx.options?.captureOnCompact === true) {
    // autoCapture is the master switch (zero-token default preserved).
    console.warn(
      "[opencode-self-improvement] captureOnCompact is on but autoCapture is off; compaction capture stays disabled (autoCapture is the master switch).",
    );
  }
  return { onCompactCapture, cleanup: captureCleanup };
}
