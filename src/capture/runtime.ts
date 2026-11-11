// Opt-in capture configuration and dispatch (#168). Cooldowns remain process-wide;
// subscriptions and dispatch closures belong to one setup instance.
import type { Cleanup } from "@opencode/plugin/promise/plugin";
import { cmpTs } from "../core/cmp-ts.ts";
import { session, setCurrent } from "../core/state.ts";
import { AUTO_CAPTURE_TAG, USER_GUIDED_TAG } from "../core/tags.ts";
import { record, recordCaptureLag } from "../evidence/record.ts";
import { type GateContext, runWriteGate } from "../gate/gate.ts";
import { captureSessionID } from "../identity/host-events.ts";
import { bindSessionProvisional, writeTarget } from "../identity/repokey.ts";
import { loadAll } from "../store/files/load.ts";
import { isInjectable } from "../store/model/predicates.ts";
import {
  type Reader,
  readerFromSid,
  visibleTo,
} from "../store/model/visibility.ts";
import { quarantineCandidate } from "../store/quarantine/quarantine.ts";
import { flattenMemoryText } from "../store/sanitize.ts";
import { redactSecrets } from "../store/secrets.ts";
import { parseCandidates, parseModelRef } from "./candidates.ts";
import { availabilityIndex } from "./available.ts";
import {
  findGuidedQuotes,
  mergeGuidedCandidates,
  normWs,
  validateGuidedQuotes,
} from "./guided-rules.ts";
import { lagSince } from "./lag.ts";
import {
  advanceCaptureCursor,
  captureCursor,
  captureSignalSince,
  deltaMessages,
  guidedStatementInWindow,
  prefixFingerprint,
  transcriptReplaced,
} from "./policy.ts";
import { buildCapturePrompt } from "./prompt.ts";
import { type SessionModelRef, sessionModel } from "./session-model.ts";
import {
  flattenTranscript,
  splitTranscript,
  userTurnText,
} from "./transcript.ts";

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
  guarded: (
    name: string,
    fn: () => Promise<void>,
    reportable?: () => boolean,
  ) => Promise<void>;
  /**
   * Fix A (FINDINGS 2026-11-08 §4b): called after a guided row is promoted,
   * so every tracked session recomputes its epoch and the NEXT request of
   * each session carries the row. Absent (or failing) changes nothing: the
   * row is stored either way and a later request re-reads the store.
   */
  onGuidedPromoted?: (sid: string) => void | Promise<void>;
}

// Tag on store rows captured by the COMPACTION trigger (issue #41). Rows keep
// the shared "auto-capture" provenance tag (src/inject.ts renders it) and add
// this one so decay/status can tell which trigger wrote them — the same
// distinction the auto_capture_compaction_* evidence lines carry.
const CAPTURE_COMPACT_TAG = "auto_capture_compaction";

async function knownRowsFor(reader: Reader): Promise<string> {
  try {
    const rows = visibleTo(await loadAll(), reader)
      .filter(isInjectable)
      .sort((a, b) => cmpTs(b.ts, a.ts))
      .slice(0, 15);
    const lines: string[] = [];
    let length = 0;
    for (const row of rows) {
      // Scrub complete legacy values before cropping, or a token prefix can
      // fall outside the window and leave an unrecognizable secret fragment.
      const scope = flattenMemoryText(redactSecrets(row.scope));
      const content = flattenMemoryText(redactSecrets(row.content)).slice(
        0,
        90,
      );
      const line = `- ${scope}: ${content}`;
      if (length + line.length > 1400) break;
      lines.push(line);
      length += line.length + 1;
    }
    return lines.join("\n");
  } catch {
    // The write gate still deduplicates when this optional context is absent.
    return "";
  }
}

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
  { instanceDir, gateContext, guarded, onGuidedPromoted }: CaptureDependencies,
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
    // Deterministic guided-candidate pre-pass (POC): default OFF, the bench
    // picks the default-on arm (FINDINGS 2026-11-08 §4.4).
    const guidedRules = ctx.options?.captureGuidedRules === true;
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
      // #211 (LIFE-1): passes in flight, tracked so teardown can stop them.
      // Aborting the subscription is not enough on its own: `generate.text`
      // does not take the signal, so a pass parked mid-model-call when the
      // host disposes this instance wakes up afterwards and used to run the
      // whole write gate against a store its caller had already torn down —
      // gate receipts, promoted rows, supersession. The contract is bounded
      // and explicit:
      //   1. cleanup aborts the subscription, so no NEW pass starts;
      //   2. every pass checks the signal after the model call and between
      //      candidates, and stops BEFORE the next gate run — a gate already
      //      mutating is never cut in half, because a half-applied gate is
      //      worse than a late one;
      //   3. cleanup then drains the tracked passes up to DRAIN_LIMIT_MS, so
      //      a caller that removes the store right after cleanup sees nothing
      //      straggling. A generate that outlives the bound is covered by (2),
      //      not by the drain: teardown never waits on the model.
      const DRAIN_LIMIT_MS = 1000;
      const inFlight = new Set<Promise<unknown>>();
      function track<T>(pass: Promise<T>): Promise<T> {
        const wrapped = pass.finally(() => inFlight.delete(wrapped));
        inFlight.add(wrapped);
        return wrapped;
      }
      async function drainInFlight(): Promise<void> {
        if (!inFlight.size) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bound = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DRAIN_LIMIT_MS);
        });
        await Promise.race([Promise.allSettled([...inFlight]), bound]).finally(
          () => clearTimeout(timer),
        );
      }
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

      // Bind the capturing session and freeze its evidence context in ONE sync
      // step, before the capture's first await. Binding is not enough on its
      // own: record() resolves a session's repository at CALL time, so a
      // `session.moved` delivered during the model call moves it, and every
      // receipt appended after that await carries the NEW repository. The
      // failure of repo A's capture would then be readable only from repo B
      // and invisible to the session that actually failed. Callers freeze
      // here and thread the result through, including into their own failure
      // receipt.
      function bindCapture(sid: string): GateContext {
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
        return gateContext(sid);
      }

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
        // Frozen by the trigger before its first await, so a session move
        // cannot re-stamp this operation's receipts. Optional for direct
        // callers, which bind here instead.
        gate?: GateContext,
      ): Promise<void> {
        const captureGate = gate ?? bindCapture(sid);
        const captureReader = captureGate.reader ?? readerFromSid(sid);
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
        // #334: the signal gate. The PORT moved it AFTER the context read
        // (the POC ran it before): a user-stated spec with no tool activity
        // is exactly the hint channel (#339) and must not be skipped, and
        // detecting it needs the messages. The read is a local host call;
        // the expensive artifact the gate saves — the capture model call —
        // is still saved.
        const cursor = captureCursor(sid);
        // The turn this pass DESCRIBES. Completion must advance to this number,
        // not to whatever the session has reached by then: a turn delivered
        // while the model call is in flight was never in the prompt, and
        // consuming it leaves that work unmined with nothing left to ask for it
        // (#366 review).
        const turnAtStart = session(sid).turns;
        let transcript = seeded;
        let msgs = seededMsgs;
        // The array AS READ, before any delta slice: the cursor's fingerprint
        // covers the consumed prefix of that array, not of the window.
        let readMsgs = seededMsgs;
        // A seeded compaction payload is the pre-compaction window the hook
        // deliberately handed over (the Compaction Cliff: one round retains 53%
        // of exact-wording rules), so it is mined whole and the cursor is not
        // consulted — which also means the cursor advances TO its length, never
        // past it by the old count.
        const minedWhole = seededMsgs !== undefined;
        // True when the context is no longer the array the cursor counted
        // (#366 review): the offset names a transcript that does not exist, so
        // the window below is the whole context, mined from the beginning.
        let deltaRestart = false;
        if (transcript.length < 200) {
          msgs = await contextFn({ sessionID: sid });
          // #211: disposed while the host was answering. The drain in cleanup()
          // waits a bound, not forever, so this is the normal outcome of a
          // teardown during a slow context read — and everything below writes:
          // the thin-transcript receipt below, then the model call. Silent, for
          // the same reason the post-model check is.
          if (controller.signal.aborted) return;
          readMsgs = msgs;
          transcript = flattenTranscript(msgs);
          // Told in BOTH modes. With the delta off the pass mines the whole
          // context anyway, and the guidance window further down has to follow
          // the same array the pass reads.
          deltaRestart = transcriptReplaced(msgs, cursor);
          if (captureDelta && !deltaRestart) {
            const before = msgs;
            msgs = deltaMessages(msgs, cursor.msgs);
            if (msgs !== before) transcript = flattenTranscript(msgs);
          }
        }
        if (captureOnSignal) {
          let verdict = captureSignalSince(session(sid), cursor.turn);
          if (
            !verdict.ok &&
            guidedStatementInWindow(
              msgs,
              captureDelta || deltaRestart ? 0 : cursor.msgs,
            )
          )
            verdict = { ok: true, why: "guidedStatement" };
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
        // The user's turns, decoded from the message array rather than read back
        // out of rendered text (#364 review). Everything that vouches for "these
        // are the user's own words" goes through this.
        const userTurns = userTurnText(msgs);
        // Hoisted out of the prompt literal so the disposal check below runs
        // BEFORE the model call: this read is awaited, so it is its own window
        // into a teardown (#211).
        const knownRows = await knownRowsFor(captureReader);
        if (controller.signal.aborted) return;
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
            knownRows,
          ),
        });
        const text = typeof out === "string" ? out : (out?.text ?? "");
        // #211: disposed while the model call was in flight. Stop here — the
        // gate, the rows and the receipts below all write to a store the
        // caller may already have removed. Silent on purpose: a receipt here
        // is the ENOENT teardown noise this check exists to eliminate, and
        // the drain in cleanup means the pass is finished, not lost mid-air.
        if (controller.signal.aborted) return;
        let candidates = parseCandidates(text, captureMax);
        // Deterministic guided pre-pass (POC, FINDINGS 2026-11-08 §4, option
        // `captureGuidedRules`): the user's own lines decide what is guided —
        // the model phrases it but cannot veto it, and a quote the user never
        // wrote is refused at the write boundary (retriable, not silent).
        // The scanned text is the structured USER turns and nothing else
        // (#364 review): assistant output never enters the haystack, so a stored
        // quote can only be what the user said. Filtering rendered lines by a
        // `user:` prefix did not do this — it accepted a `user:` label quoted
        // INSIDE an assistant message as provenance.
        if (guidedRules) {
          const ruleUserText = redactSecrets(userTurns);
          if (!ruleUserText.trim()) {
            // No user turn in what was mined (a seeded transcript with no message
            // array, or a session that has only said nothing). Fail closed: with
            // no roles there is nothing to vouch for, so the lane stays shut
            // rather than minting a row from prose of unknown origin.
            //
            // #364 review round 2: the receipt alone does not shut it. A guided
            // candidate the MODEL supplied would still have been stored with its
            // unverified quote, so with no user turn nothing is attributable and
            // the guided flag plus the quote come off. The distilled prose stays:
            // an ordinary capture row is what the same model output produces with
            // the option off, and dropping the row would trade a provenance fix
            // for a recall loss the plugin has no licence to make here.
            let withheld = 0;
            for (const c of candidates) {
              if (c.guided !== true) continue;
              c.guided = false;
              c.original = undefined;
              withheld++;
            }
            await record(
              "auto_capture_rules",
              {
                session: sid,
                trigger,
                quotes: 0,
                refused: 0,
                withheld,
                skipped: "no_user_turn",
                model: modelTag,
              },
              false,
              sid,
              captureGate.evidenceContext,
            );
          } else {
            const quotes = findGuidedQuotes(ruleUserText);
            const checked = validateGuidedQuotes(candidates, ruleUserText);
            candidates = mergeGuidedCandidates(quotes, checked.kept);
            await record(
              "auto_capture_rules",
              {
                session: sid,
                trigger,
                quotes: quotes.length,
                refused: checked.refused.length,
                model: modelTag,
              },
              false,
              sid,
              captureGate.evidenceContext,
            );
          }
        } else {
          // Lenient check (default): a guided "original" must appear in the
          // user's own turns. The prompt asks for a quote "copied VERBATIM from
          // a user: line or the REQUESTS block", so the haystack is exactly that
          // (#364 review: the mined WORK text used to be in here too, which
          // vouched for a quote lifted out of assistant output). Whitespace is
          // normalised — the model may collapse runs of spaces. A failed check
          // drops the field, never the row: the distilled prose still
          // deserved storage, it just cannot be vouched for as the user's
          // own words.
          const quoteHay = redactSecrets(userTurns).replace(/\s+/g, " ");
          for (const c of candidates) {
            if (
              c.original !== undefined &&
              !quoteHay.includes(normWs(c.original))
            )
              c.original = undefined;
          }
        }
        // #389: availability before authority. A candidate that restates a
        // tracked file, or names a command the project already declares, is
        // readable by the next session without a row — and capture costs about a
        // third of a session's own generation. Built once per pass: one
        // `git ls-files`, one shared byte budget. It REFUSES; it never deletes,
        // so a row the store has always kept is untouched (criterion 6).
        const available = availabilityIndex(
          captureReader.kind === "repo" ? captureReader.scope.path : undefined,
        );
        for (const c of candidates) {
          // Between candidates, never inside a gate run: a supersession that
          // half-applied is a store the next session cannot trust.
          if (controller.signal.aborted) return;
          const avail = available.check(c.content);
          if (avail) {
            // Refused as restatable, not as wrong. A guided row can land here:
            // if the user's words are verbatim in the tree, the tree answers
            // them, and a row that contradicts the tree is by definition NOT
            // verbatim in it, so the contradiction case still gets stored.
            await record(
              "auto_capture_available",
              {
                session: sid,
                trigger,
                type: c.type,
                scope: redactSecrets(c.scope),
                reason: avail.reason,
                where: avail.where,
                matched: avail.matched,
                ...(c.guided ? { guided: true } : {}),
                ...(modelTag ? { model: modelTag } : {}),
              },
              false,
              sid,
              captureGate.evidenceContext,
            );
            continue;
          }
          const original = c.original;
          const durable: string[] = [];
          let outcome: Awaited<ReturnType<typeof runWriteGate>>;
          try {
            outcome = await runWriteGate(
              quarantineCandidate({
                type: c.type,
                scope: c.scope,
                content: c.content,
                ...(c.status ? { status: c.status } : {}),
                ...(c.kw ? { kw: c.kw } : {}),
                ...(c.ref ? { ref: c.ref } : {}),
                ...(c.claim ? { claim: c.claim } : {}),
                ...(c.klass ? { klass: c.klass } : {}),
                // Verified verbatim utterance (see quoteHay above): injection
                // renders it so the user's exact words ride the next session's
                // request bytes.
                ...(original ? { original } : {}),
                tags: [
                  AUTO_CAPTURE_TAG,
                  ...(trigger === "compaction" ? [CAPTURE_COMPACT_TAG] : []),
                  ...(c.guided ? [USER_GUIDED_TAG] : []),
                ],
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
              ...(outcome.action === "promoted" && c.guided
                ? {
                    conflict:
                      c.ref && c.claim && c.klass
                        ? "full"
                        : c.ref || c.claim || c.klass
                          ? "partial"
                          : "absent",
                  }
                : {}),
              // Stage telemetry (mystery 2): the row's identity and guided
              // standing at the moment of storage, so a later L6h miss can be
              // joined to the exact row that did or did not enter the hint
              // channel, and to whether its verbatim quote survived the
              // substring check.
              ...(outcome.action === "promoted" ? { row: outcome.ts } : {}),
              ...(c.guided ? { guided: true } : {}),
              ...(original ? { orig: true } : {}),
            },
            false,
            sid,
            captureGate.evidenceContext,
          );
          // Fix A (FINDINGS 2026-11-08 §4b): a guided row promoted after a
          // session froze its bytes could never enter the hint lane (bench
          // run 5: capture landed 9 min into pass 2, epoch never moved).
          // Recompute every tracked epoch now, so the next request of each
          // session carries the row. Fail-soft: the row is stored either way,
          // and a later request re-reads the store on its own.
          if (c.guided && outcome.action === "promoted" && onGuidedPromoted) {
            try {
              await onGuidedPromoted(sid);
            } catch {
              /* fail-soft — see above */
            }
          }
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
          // A window is consumed by the pass that mined it. A seeded payload or
          // a replaced transcript IS the whole window, so the cursor becomes its
          // length; an ordinary delta window sits AFTER what was mined before.
          const total = !Array.isArray(msgs)
            ? cursor.msgs
            : minedWhole || deltaRestart || !captureDelta
              ? msgs.length
              : cursor.msgs + msgs.length;
          advanceCaptureCursor(
            sid,
            total,
            turnAtStart,
            prefixFingerprint(readMsgs, total),
          );
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
            // Freeze the operation's evidence context before its first await.
            // The catch below runs after the model call, where a
            // `session.moved` may already have re-pointed this session at
            // another repository; resolving it there would stamp the failure
            // receipt of repo A's capture as repo B's evidence.
            let opGate: GateContext | undefined;
            try {
              opGate = bindCapture(sid);
              await track(captureSession(sid, "", "idle", undefined, opGate));
            } catch (err) {
              // Teardown is not a capture failure: after cleanup the store may
              // be gone, and a receipt here would be the ENOENT noise #211
              // reports. The abort check inside captureSession is the signal.
              if (controller.signal.aborted) return;
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
                opGate?.evidenceContext,
              );
            }
          }
        } catch {
          // the subscription itself ended (abort or host error); nothing to do
        }
      })();
      captureCleanup = async () => {
        controller.abort();
        await drainInFlight();
      };

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
          // Same freeze as the idle trigger, and for the same reason: sync,
          // before guarded() starts awaiting.
          const opGate = bindCapture(sid);
          // Tracked, not just fired: cleanup must be able to drain this pass
          // (#211), which is the only reason the seam keeps the promise.
          void track(
            // The predicate, not just the checks inside the pass: a rejection
            // from the awaited model call skips every abort check that follows
            // it and lands in the generic reporter, which would append
            // `hook_error` to a store cleanup() has already released (#211).
            guarded(
              "session.compaction (auto-capture)",
              () =>
                captureSession(
                  sid,
                  flattenTranscript(messages),
                  "compaction",
                  messages,
                  opGate,
                ),
              () => !controller.signal.aborted,
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
