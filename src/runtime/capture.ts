// Opt-in capture configuration and dispatch. Cooldowns remain process-wide;
// subscriptions and dispatch closures belong to one setup instance.
import type {
  CompactCapture,
  CaptureTranscript,
  MemoryCaptureHost,
} from "../host/capture.ts";
import { existsSync } from "node:fs";
import { cmpTs } from "../core/cmp-ts.ts";
import { evidenceDir } from "../core/config/paths.ts";
import { session, setCurrent } from "../core/state.ts";
import {
  AUTO_CAPTURE_TAG,
  CODE_CHECKED_TAG,
  USER_GUIDED_TAG,
} from "../core/tags.ts";
import { type GateContext, runWriteGate } from "../gate/gate.ts";
import {
  bindSessionProvisional,
  sessionBindingToken,
  writeTarget,
} from "../identity/repokey.ts";
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
import {
  recordBestEffort,
  recordCaptureLagBestEffort,
  recordSyncBestEffort,
  safeErrorMessage,
} from "../telemetry/record.ts";
import {
  type AvailabilityIndex,
  availabilityIndex,
} from "../capture/available.ts";
import { ledgerText, withholdUngroundedGuidance } from "../capture/attest.ts";
import { parseCandidates, parseModelRef } from "../capture/candidates.ts";
import { claimVerdictFromContent } from "../capture/checked.ts";
import {
  findGuidedQuotes,
  mergeGuidedCandidates,
  normWs,
  validateGuidedQuotes,
} from "../capture/guided-rules.ts";
import { lagSince } from "../capture/lag.ts";
import {
  advanceCaptureCursor,
  attestedGateFailures,
  captureCursor,
  captureSignalSince,
  deltaMessages,
  guidedStatementInWindow,
  prefixFingerprint,
  transcriptReplaced,
} from "../capture/policy.ts";
import { buildCapturePrompt } from "../capture/prompt.ts";
import { sessionModel } from "../capture/session-model.ts";
import {
  flattenTranscript,
  splitTranscript,
  userTurnText,
} from "./transcript.ts";

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

// Tag on store rows captured by the COMPACTION trigger. Rows keep
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

// Auto-capture cooldown, shared by EVERY setup() registration: setup
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

export function configureAutoCapture(
  host: MemoryCaptureHost,
  options: Record<string, unknown>,
  { instanceDir, gateContext, guarded, onGuidedPromoted }: CaptureDependencies,
) {
  let onCompactCapture: CompactCapture | undefined;
  let captureCleanup: (() => Promise<void>) | undefined;
  if (options.autoCapture !== false) {
    const captureModelOpt = options.captureModel;
    // an OMITTED captureModel does not disable the subscription. It
    // resolves per capture — the per-session ref last seen on session.context,
    // else the host default — and only when both are missing does the pass
    // skip. autoCapture is on by default, so the switch itself is the consent;
    // requiring a second config string would be a syntax tax whose failure mode
    // is a console.warn nobody reads. An explicit but INVALID captureModel
    // keeps the fail-closed setup behaviour: silently substituting another
    // model than the one the user typed is worse than the tax it replaces.
    const omitted = captureModelOpt === undefined;
    const captureMax = Number(options.captureMax) || 3;
    // Deterministic guided-candidate pre-pass (POC): default OFF, the bench
    // picks the default-on arm (FINDINGS 2026-11-08 §4.4).
    const guidedRules = options.captureGuidedRules === true;
    const captureOnCompact = options.captureOnCompact !== false;
    // two cost levers, both OFF by default until the benchmark says which
    // way to set them. `captureOnSignal` skips a capture whose turn produced
    // nothing durable; `captureDelta` mines only the turns since the last
    // capture instead of re-reading the whole session every time.
    const captureOnSignal = options.captureOnSignal === true;
    const captureDelta = options.captureDelta === true;
    const modelRef = omitted ? null : parseModelRef(captureModelOpt);
    if (!omitted && !modelRef) {
      // Invalid explicit model: skip registering the whole subscription
      // rather than guess (and warn once, at setup).
      console.warn(
        `[opencode-self-improvement] autoCapture is on but captureModel ${JSON.stringify(captureModelOpt)} is invalid (expected "provider/id"); auto-capture disabled.`,
      );
    } else if (
      !host.turnEndEvents ||
      !host.generateText ||
      !host.readTranscript
    ) {
      console.warn(
        "[opencode-self-improvement] autoCapture is on but this host lacks turn-end events, model generation, or transcript access; auto-capture disabled.",
      );
    } else {
      const controller = new AbortController();
      // passes in flight, tracked so teardown can stop them.
      // Aborting the subscription is not enough on its own: some hosts cannot
      // cancel generation, so a pass parked mid-model-call when the
      // host disposes this instance wakes up afterwards and used to run the
      // whole write gate against a store its caller had already torn down —
      // gate receipts, promoted rows, supersession. The contract is bounded
      // and explicit:
      //   1. cleanup aborts the subscription, so no NEW pass starts;
      //   2. every pass checks its own abandonment flag after the model call and
      //      between candidates, and stops BEFORE the next gate run — a gate
      //      already mutating is never cut in half, because a half-applied gate is
      //      worse than a late one;
      //   3. cleanup then drains the tracked passes up to DRAIN_LIMIT_MS, so
      //      a caller that removes the store right after cleanup sees nothing
      //      straggling. A pass still working when the bound expires is abandoned
      //      there and then, so it stops at its next candidate boundary; a
      //      generate that outlives the bound is covered by (2), not by the
      //      drain: teardown never waits on the model.
      //
      // Teardown distinguishes two phases (docs/adr/0005). A pass PARKED in
      // `generate.text` when the host disposes must never write — the caller
      // may remove the store the moment cleanup resolves. A pass that already
      // HOLDS its model answer is different work: the answer exists, the gate
      // is milliseconds of local work, and on `opencode run` nothing is being
      // removed at all — the process simply exits. Aborting past-model passes
      // is why most real CLI passes recorded `capture_cost` and no row (9 of
      // 12 in one sample, 6 of 12 in a controlled A/B). Past-model passes are
      // bounded by the drain instead, which is what the drain is for.
      const DRAIN_LIMIT_MS = 1000;
      type PassPhase = {
        /** Set the instant `generate.text` resolves. */
        pastModel: boolean;
        /** Set by cleanup, and only for a pass that has not answered yet. */
        abandoned: boolean;
      };
      const inFlight = new Set<Promise<unknown>>();
      const passPhases = new Set<PassPhase>();
      // Observability counters, read at disposal. `turnEndSeen` counts the
      // turn-end events this instance's subscription actually received; `passesStarted`
      // counts the capture passes that began. Together they make the silent state
      // interpretable: a process that exits with `turnEndSeen === 0 && passesStarted
      // === 0` never got the event, which is a different fact from "a pass ran and
      // found nothing" (a `capture_cost` line) and from "disabled" (the `plugin_load`
      // heartbeat). Both are process-wide for this setup instance, not per-session:
      // the question they answer is "did capture get a chance at all on this host."
      let turnEndSeen = 0;
      let passesStarted = 0;
      function newPhase(): PassPhase {
        return { pastModel: false, abandoned: false };
      }
      function track<T>(pass: Promise<T>, phase?: PassPhase): Promise<T> {
        const wrapped = pass.finally(() => {
          inFlight.delete(wrapped);
          if (phase) passPhases.delete(phase);
        });
        if (phase) passPhases.add(phase);
        inFlight.add(wrapped);
        return wrapped;
      }
      /**
       * Teardown, in two phases (docs/adr/0005).
       *
       * 1. Abandon every pass that has not answered yet, then drain what is
       *    left, bounded. A parked `generate.text` can outlive any bound, so
       *    abandoning it is what makes the bound mean something: the caller
       *    may remove the store the moment cleanup resolves.
       * 2. A pass that already holds its answer is never abandoned. It is
       *    drained instead, because its remaining work is the gate — local,
       *    milliseconds — and killing it is what lost most real CLI captures
       *    (9 of 12 in one sample, 6 of 12 in a controlled A/B).
       *
       * The residual risk is a stated constant, not an accident. If the bound
       * expires while a past-model pass is still working, cleanup returns and at
       * most the gate run already in progress can land afterwards — the drain
       * abandons the pass so its remaining candidates stop at the next boundary.
       * Without the phase split the residual was unbounded in a different way:
       * a generate that outlived the bound woke up and ran the whole gate.
       * Neither version ever cuts a gate in half.
       *
       * Nothing here writes. The tested contract is that a disposed instance
       * leaves no trace at all after cleanup, and an abandonment receipt would
       * break it in all four of that contract's cases — `appendLog` calls
       * `ensureDir`, so the receipt resurrects a directory the caller deleted.
       * An abandoned pass is instead identified by the gap it leaves: a
       * `capture_cost` line with no later `capture_lag` is an unresolved outcome.
       * It does not prove loss: a store write can precede its completion receipt.
       */
      async function drainInFlight(): Promise<void> {
        for (const phase of passPhases) {
          if (!phase.pastModel) phase.abandoned = true;
        }
        if (!inFlight.size) return;
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const bound = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, DRAIN_LIMIT_MS);
        });
        await Promise.race([Promise.allSettled([...inFlight]), bound]).finally(
          () => clearTimeout(timer),
        );
        // The bound expired, so cleanup is returning while a pass still works.
        // Abandon it now: it is past the model, so it may not be stopped inside a
        // gate run, but it stops at the next candidate boundary instead of
        // running an unbounded list against a process that is on its way out.
        // That makes the residual risk a stated constant — at most the one gate
        // run already in progress can land after cleanup returns — rather than a
        // function of how many candidates the model returned.
        if (timedOut) for (const phase of passPhases) phase.abandoned = true;
      }
      const turnEndEvents = host.turnEndEvents;
      const generateText = host.generateText;
      const readTranscript = host.readTranscript;

      // model resolution: explicit option (captured above) wins; else the
      // ref this session's context hook last carried; else the host default.
      // Warn-once per setup when even the last resort is empty — a per-event
      // warn would spam the log for every turn of a model-less session.
      let warnedNoModel = false;
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
        // `sid` explicitly instead of reading it back from the global.
        setCurrent({ sessionID: sid });
        // The capture's dedup reads and the rows it writes partition by the
        // CAPTURED session's repository — an unbound sid would otherwise
        // read global-only and mine duplicates into the store (in
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
        seededMsgs?: CaptureTranscript,
        // Frozen by the trigger before its first await, so a session move
        // cannot re-stamp this operation's receipts. Optional for direct
        // callers, which bind here instead.
        gate?: GateContext,
        // Teardown phase, owned by the caller that `track()`s this pass. Both
        // production triggers pass one. The default is for direct callers —
        // tests, and any future seam that runs a pass outside the subscription —
        // and reads "not drainable, so not abandonable": an untracked pass is
        // not in `inFlight`, so cleanup could neither wait for it nor stop it
        // safely, and killing work the drain cannot bound is the failure mode
        // this parameter exists to avoid.
        phase: PassPhase = { pastModel: true, abandoned: false },
      ): Promise<void> {
        const captureGate = gate ?? bindCapture(sid);
        const binding = sessionBindingToken(sid);
        const bindingChanged = () => {
          if (sessionBindingToken(sid) === binding) return false;
          recordSyncBestEffort(
            "auto_capture_skipped",
            { session: sid, trigger, reason: "session_moved" },
            true,
            sid,
            captureGate.evidenceContext,
          );
          return true;
        };
        const captureReader = captureGate.reader ?? readerFromSid(sid);
        // Completion advances only to the turn this pass describes, even when
        // default-model lookup or generation allows later turns to arrive.
        const turnAtStart = session(sid).turns;
        // resolve the model BEFORE any skip so every capture evidence
        // line below can carry model= (cost attributable to a named model —
        // the real answer to the cost-surprise concern that justified the
        // required captureModel). Resolution itself is token-free.
        const model =
          modelRef ?? sessionModel(sid) ?? (await host.defaultModel?.(sid));
        if (controller.signal.aborted) return;
        // Ownership is frozen, but the transcript has not been read yet.
        if (bindingChanged()) return;
        const modelTag = model ? `${model.providerID}/${model.id}` : undefined;
        // an instance with no workspace cannot say which repository the
        // mined rows belong to, and rows with no owner are exactly what the
        // store refuses. Skip BEFORE the model call — no tokens spent on a
        // capture that cannot be stored — and leave the reason in evidence.
        if (!writeTarget(sid).ok) {
          await recordBestEffort(
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
              "[opencode-self-improvement] autoCapture is on but captureModel is omitted and neither the session nor the host default names a model; capture skipped (warned once).",
            );
          }
          await recordBestEffort(
            "auto_capture_refused",
            { session: sid, trigger, reason: "no_model" },
            true,
            sid,
            captureGate.evidenceContext,
          );
          return;
        }
        // the signal gate. The PORT moved it AFTER the context read
        // (the POC ran it before): a user-stated spec with no tool activity
        // is exactly the hint channel and must not be skipped, and
        // detecting it needs the messages. The read is a local host call;
        // the expensive artifact the gate saves — the capture model call —
        // is still saved.
        const cursor = captureCursor(sid);
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
        // the offset names a transcript that does not exist, so
        // the window below is the whole context, mined from the beginning.
        let deltaRestart = false;
        if (transcript.length < 200) {
          msgs = await readTranscript(sid);
          // disposed while the host was answering. The drain in cleanup()
          // waits a bound, not forever, so this is the normal outcome of a
          // teardown during a slow context read — and everything below writes:
          // the thin-transcript receipt below, then the model call. Silent, for
          // the same reason the post-model check is.
          if (controller.signal.aborted) return;
          if (bindingChanged()) return;
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
            await recordBestEffort(
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
          await recordBestEffort(
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
        // how stale is a capture? Distance from the newest message of
        // the mined transcript to this instant - measured on whatever the
        // trigger actually mined (the hook payload for compaction, the
        // session context for idle), so both triggers' lag is comparable.
        const lagMs = lagSince(msgs);
        // partition what was mined, so the user's brief is labelled as
        // the brief instead of blending into the evidence. Falls back to the
        // single un-partitioned block when the work lines alone are too thin
        // (a seeded transcript with no message array behind it), which keeps
        // the old prompt shape rather than silently dropping the prose.
        const split = splitTranscript(msgs);
        const partitioned = split.work.length >= 200;
        const work = partitioned ? split.work : transcript;
        const userProse = partitioned ? split.user : "";
        // The user's turns, decoded from the message array rather than read back
        // out of rendered text. Everything that vouches for "these
        // are the user's own words" goes through this.
        const userTurns = userTurnText(msgs);
        // Hoisted out of the prompt literal so the disposal check below runs
        // BEFORE the model call: this read is awaited, so it is its own window
        // into a teardown.
        const knownRows = await knownRowsFor(captureReader);
        if (controller.signal.aborted) return;
        // S1: the ledger's unrecovered gate failures, in the same window the
        // signal policy just approved. Rendered into the prompt so the model
        // can cite one, and kept here so the citation can be checked against
        // the ledger rather than against the model's retelling. `undefined`,
        // not `[]`, means "this caller does not know about lessons" and leaves
        // the prompt byte-identical to before; an empty array is a statement
        // that nothing failed, and the prompt says so.
        const attested = attestedGateFailures(session(sid), cursor.turn).map(
          (f) =>
            // Ledger args are raw tool input. A failing
            // `bun test --token=sk-...` put the credential verbatim into the
            // ATTESTED FAILURES block — the transcript scrub does not cover
            // this input. Redact at construction, so the prompt renders the
            // safe string AND the citation check compares against the same
            // representation the model was shown (docs/adr/0006).
            redactSecrets(f.arg ? `${f.cmd} — ${f.arg}` : f.cmd),
        );
        // A lesson citation must copy a COMPLETE displayed field. Substring
        // presence cannot establish that the cited command ran:
        // `includes("tsc")` accepted a lesson citing `tsc` when the only
        // failure was `bun test --test-name-pattern tsc`. The list renders
        // `cmd — arg`; membership is tested against each whole entry, its
        // cmd, and its arg — never a fragment. `tsc` is none of those for
        // that failure and is refused; the cmd-only citation the prompt's own
        // example uses still passes.
        const lessonSet = new Set<string>();
        for (const f of attested) {
          lessonSet.add(normWs(f).toLowerCase());
          const sep = f.lastIndexOf(" — ");
          if (sep > 0) {
            lessonSet.add(normWs(f.slice(0, sep)).toLowerCase());
            lessonSet.add(normWs(f.slice(sep + 3)).toLowerCase());
          }
        }
        // Hoisted so its length can be billed below.
        // Redact the COMPLETE transcript, THEN apply the character budget
        //. Cropping first can start the window INSIDE a credential:
        // a PEM body whose BEGIN marker fell off, or a token whose prefix
        // fell off, matches no pattern — buildCapturePrompt's own scrub
        // (kept, defense in depth) cannot recognize a fragment.
        const capturePrompt = buildCapturePrompt(
          redactSecrets(work).slice(-7000),
          captureMax,
          redactSecrets(userProse).slice(-1500),
          knownRows,
          attested,
        );
        const promptChars = capturePrompt.length;
        // The receipt that a capture pass began, written SYNCHRONOUSLY at the
        // last point before the model call — after every skip decision, so a turn
        // that deliberately skipped (no signal, thin transcript) records
        // `auto_capture_skipped` and never this line. `auto_capture_start` means
        // exactly one thing: the pass reached the model call. It must not be
        // async: an async write here yields the event loop several times and
        // measurably shrinks the window the model call has to finish before the
        // host exits. It sits after the context read and the known-rows read on
        // purpose, so a start line with no `capture_cost` is a pass cut AT the
        // model call — the state otherwise byte-identical to "disabled" or "ran
        // and found nothing." The cost of that placement: a pass cut DURING the
        // context read or the known-rows read, before this line, still leaves no
        // trace, so that band is silent by design (see the evidence doc). The
        // write is best-effort: an unwritable evidence log (read-only mount,
        // foreign owner, ENOSPC) must never abort the pass before its model
        // call — observability cannot be allowed to cause the loss it exists to
        // detect.
        passesStarted++;
        recordSyncBestEffort(
          "auto_capture_start",
          {
            trigger,
            ...(modelTag ? { model: modelTag } : {}),
          },
          true,
          sid,
          captureGate.evidenceContext,
        );
        const text = await generateText({
          sessionID: sid,
          model,
          prompt: capturePrompt,
          signal: controller.signal,
        });
        // The phase boundary. From here the answer exists, so cleanup stops
        // abandoning this pass and drains it instead. Set before the next
        // await, so a disposal during anything below cannot be missed.
        phase.pastModel = true;
        // abandoned while the model call was in flight. Stop here — the
        // gate, the rows and the receipts below all write to a store the
        // caller may already have removed. Silent on purpose: a receipt here
        // is the ENOENT teardown noise this check exists to eliminate, and
        // the drain in cleanup means the pass is finished, not lost mid-air.
        if (phase.abandoned) return;
        // bill our own call. `generate.text` resolves to `{ text }` and
        // nothing else — no `usage`, no `tokens` (probed against the running
        // host) — and capture is not part of any session's event stream, so a
        // meter reading the session reports zero for it. chars/4 is an
        // estimate and the line says `receipt=none` so it can never be quoted
        // as a provider number.
        //
        // Deliberately AFTER the teardown check above: a disposed pass has no
        // store left to write to. Its tokens therefore go unbilled here, which
        // undercounts by one call at teardown rather than throwing ENOENT out
        // of a receipt path that must never break a session.
        await recordBestEffort(
          "capture_cost",
          {
            session: sid,
            trigger,
            prompt_chars: promptChars,
            text_chars: text.length,
            est_tokens: Math.ceil((promptChars + text.length) / 4),
            receipt: "none",
            ...(modelTag ? { model: modelTag } : {}),
          },
          true,
          sid,
          captureGate.evidenceContext,
        );
        let candidates = parseCandidates(text, captureMax);
        // Deterministic guided pre-pass (POC, FINDINGS 2026-11-08 §4, option
        // `captureGuidedRules`): the user's own lines decide what is guided —
        // the model phrases it but cannot veto it, and a quote the user never
        // wrote is refused at the write boundary (retriable, not silent).
        // The scanned text is the structured USER turns and nothing else
        // assistant output never enters the haystack, so a stored
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
            // the receipt alone does not shut it. A guided
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
            await recordBestEffort(
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
            await recordBestEffort(
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
          // (review: the mined WORK text used to be in here too, which
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
        // The hint channel is granted, not inherited. A quote found in a user
        // turn establishes that the user typed the words; it cannot establish
        // that the words are about THIS repository, because the task brief is a
        // user turn and a brief carries instructions written for the harness as
        // well as facts about the code. A row that always rides every later
        // session has to carry something a later session can check — a value, or
        // a name the session actually used — so the ledger decides here, the
        // same way it decides what a failure lesson may be about.
        const echoes = withholdUngroundedGuidance(
          candidates,
          ledgerText(session(sid).calls),
        );
        if (echoes)
          await recordBestEffort(
            "auto_capture_brief_echo",
            {
              session: sid,
              trigger,
              withheld: echoes,
              candidates: candidates.length,
              ...(modelTag ? { model: modelTag } : {}),
            },
            false,
            sid,
            captureGate.evidenceContext,
          );
        // availability before authority. A candidate that restates a
        // tracked file, or names a command the project already declares, is
        // readable by the next session without a row — and capture costs about a
        // third of a session's own generation.
        //
        // Built on FIRST USE, not on every pass. The build is a
        // synchronous `git ls-files` plus a read of every tracked text file —
        // measured here at 108 ms for 218 files and 2.11 MB — and the pass that
        // needs it least is the one that would pay for it: a model answer of
        // `[]` still scanned the tree. One build per pass is kept, so the cost is
        // now bounded by the candidates that exist.
        let availableIndex: AvailabilityIndex | undefined;
        let availableMs = 0;
        const availability = (): AvailabilityIndex => {
          if (!availableIndex) {
            const t0 = Date.now();
            availableIndex = availabilityIndex(
              captureReader.kind === "repo"
                ? captureReader.scope.path
                : undefined,
            );
            availableMs = Date.now() - t0;
          }
          return availableIndex;
        };
        // S1 (learn-from-failure): a row that CITES a failing command is
        // claiming to be a lesson, and the claim is checked against the ledger,
        // not against the model's retelling. ReMe (Findings ACL 2026) found
        // selective addition beats full addition because one failed trajectory
        // rarely carries enough context for a correct analysis — so the way
        // this feature fails is by storing a wrong rule, and a rule about a
        // failure that never happened (or that the agent already fixed) is the
        // worst version of it: it rides every later session as an instruction.
        //
        // The gate is monotone. Only a row carrying `failure` makes the claim,
        // so an ordinary `blocker` note — a type this capture path has always
        // written — is untouched. Refusing every uncited blocker would delete
        // rows the store has always kept, and a provenance fix does not buy a
        // recall loss here.
        let lessonsKept = 0;
        let lessonsRefused = 0;
        // `availVerdicts` counts candidates the availability check matched;
        // `restatements` counts candidates refused because of it. Two numbers
        // because they answer different questions — one about the check, one
        // about the store — and a future consequence that is not refusal must
        // not silently reuse the count.
        let availVerdicts = 0;
        let restatements = 0;
        candidates = candidates.filter((c) => {
          if (c.failure === undefined) return true;
          const cite = normWs(c.failure).toLowerCase();
          if (cite && lessonSet.has(cite)) {
            lessonsKept++;
            return true;
          }
          lessonsRefused++;
          return false;
        });
        if (lessonsKept || lessonsRefused)
          await recordBestEffort(
            "auto_capture_lessons",
            {
              session: sid,
              trigger,
              kept: lessonsKept,
              refused: lessonsRefused,
              attested: attested.length,
              ...(modelTag ? { model: modelTag } : {}),
            },
            false,
            sid,
            captureGate.evidenceContext,
          );
        for (const c of candidates) {
          // Between candidates, never inside a gate run: a supersession that
          // half-applied is a store the next session cannot trust. The phase
          // flag, not the signal: this loop only runs once the answer exists,
          // and cleanup stops abandoning such a pass.
          if (phase.abandoned) return;
          // A candidate the working tree already states, or whose only content
          // is a command the project already declares, is REFUSED here — before
          // the gate, before the store. The next session can read it from the
          // file named in the refusal line, so the row buys nothing, and a
          // capture pass costs about a third of a session's own generation.
          //
          // The refusal is the hardened matcher's, not the original rule's: it
          // fires only when EVERY assertion in the candidate is restatable
          // verbatim modulo formatting, in a sentence of the same polarity,
          // with no figure the tree does not carry. Every uncertainty — no
          // git, an unreadable file, a byte cap, a dropped negation, one new
          // number, one new clause — keeps the candidate. Fail-open is what
          // protects the transport case: a fact the tree does not hold cannot
          // match, so the store keeps everything only the store can carry. A
          // wrong keep costs one redundant row; a wrong refusal costs a fact,
          // and that is the direction the matcher's vetoes exist to make rare.
          // History: docs/adr/.
          const avail = availability().check(c.content);
          if (avail) {
            availVerdicts++;
            restatements++;
            await recordBestEffort(
              "auto_capture_restatable",
              {
                session: sid,
                trigger,
                type: c.type,
                scope: redactSecrets(c.scope),
                reason: avail.reason,
                where: avail.where,
                // `matched` is a slice of the CANDIDATE, not of the tree, so it
                // carries model prose too: measured, `Ship with \`npm run deploy\`.<NUL>`
                // yields `matched` ending in the NUL. Flattened for the reason
                // below.
                matched: flattenMemoryText(avail.matched),
                // The whole candidate: the refusal is a judgement about the
                // tree, so the audit line alone must be able to replay or
                // rebuild it. This line IS the refusal record — a restatable
                // candidate never reaches the gate, so there is no adjacent
                // `auto_capture_<action>` line for it, and `restatements` on
                // the scan line counts exactly these.
                //
                // Both free-text fields here are flattened, which nothing else on
                // this path does: `candidates.ts` checks type and scope for control
                // characters but not content, `scrubFields` only redacts
                // credentials, and the logfmt writer escapes `\ " \n \r \t` and
                // nothing else. Without this, a NUL or U+2028 from model prose
                // lands raw in the day log and `memory_evidence` hands it straight
                // back to a model. Redact FIRST: flattening a PEM body would break
                // the pattern that recognises it. The systemic version — flattening
                // every string field in `scrubFields` — is deliberately NOT done
                // here, because it would change the meaning of existing audit
                // lines that carry multi-line values.
                content: flattenMemoryText(redactSecrets(c.content)),
                ...(c.guided ? { guided: true } : {}),
                ...(modelTag ? { model: modelTag } : {}),
              },
              false,
              sid,
              captureGate.evidenceContext,
            );
            continue;
          }
          // a numeric claim capture INFERRED (the user did not state
          // it) that names a constant the tree also names is checked before it
          // is stored. Only a contradiction refuses; "undecidable" is the
          // transport case and keeps the row, labelled.
          const claim = c.guided
            ? { verdict: "undecidable" as const }
            : claimVerdictFromContent(
                captureReader.kind === "repo"
                  ? captureReader.scope.path
                  : undefined,
                c.content,
              );
          const verdict = claim.verdict;
          if (verdict === "contradicts") {
            await recordBestEffort(
              "auto_capture_contradiction",
              {
                session: sid,
                trigger,
                type: c.type,
                scope: redactSecrets(c.scope),
                reason: "claim_contradicts_tree",
                where: claim.ref ?? "",
                matched: claim.claim ?? "",
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
                  // the ONE case that earns `[code-checked]` — an inferred
                  // numeric claim that agreed with the tree. Absent everywhere
                  // else, which is what makes `[unverified]` mean something
                  // instead of decorate everything.
                  ...(verdict === "agrees" ? [CODE_CHECKED_TAG] : []),
                  ...(trigger === "compaction" ? [CAPTURE_COMPACT_TAG] : []),
                  ...(c.guided ? [USER_GUIDED_TAG] : []),
                ],
              }),
              { ...captureGate, durable },
            );
          } catch (err) {
            // A refused write must not disappear into the hook's fail-soft
            // wrapper. Preserve any earlier gate retirements in the receipt.
            await recordBestEffort(
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
          await recordBestEffort(
            trigger === "compaction"
              ? `auto_capture_compaction_${outcome.action}`
              : `auto_capture_${outcome.action}`,
            // A blocked credential-shaped scope must not reach the evidence log either.
            // The promoted line also carries the audit fault when the
            // write_promoted line fell (review — capture has no
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
        // The scan is visible in the trail. A synchronous tree read must
        // never run every pass with no record that it happened: one line per
        // pass that had candidates, naming how many it saw and what the index
        // read — files, bytes, milliseconds. `candidates` is the denominator
        // that separates a dead matcher from an honest one: `verdicts=0` at
        // `candidates>0`, across passes, is matcher death, and an empty
        // session — no candidates, no line — never produces it. When the
        // index was never built (a pass abandoned before its first
        // candidate), the read fields are zero and `tracked=false` says so.
        if (availableIndex || candidates.length) {
          const scan = availableIndex
            ? availableIndex.scanned()
            : { files: 0, bytes: 0, tracked: false, capped: false };
          await recordBestEffort(
            "auto_capture_scan",
            {
              session: sid,
              trigger,
              candidates: candidates.length,
              files: scan.files,
              bytes: scan.bytes,
              ms: availableMs,
              tracked: scan.tracked,
              capped: scan.capped,
              // `verdicts` counts candidates the check matched, `restatements`
              // candidates refused as restatements. Equal while refusal is the
              // verdict's only consequence; kept apart because they count the
              // check and the store's fate, and a future consequence that is
              // not refusal must not silently reuse the count.
              verdicts: availVerdicts,
              restatements,
              ...(modelTag ? { model: modelTag } : {}),
            },
            false,
            sid,
            captureGate.evidenceContext,
          );
        }
        await recordCaptureLagBestEffort(
          sid,
          lagMs,
          candidates.length ? "candidates" : "empty",
          captureGate.evidenceContext,
          modelTag,
        );
        // the window is consumed. Advance when a capture RAN, whatever it
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
          for await (const event of turnEndEvents(controller.signal)) {
            // The iterator may still yield an event queued before abort.
            if (controller.signal.aborted) break;
            // One event's failure stays that event's failure. The guard covers
            // the whole body, including the receipt that reports a failure,
            // because this loop is the only thing that hands capture every later
            // turn: a throw that reaches it ends auto-capture for the life of
            // the process, and the log that would say so is the thing that
            // broke. Only abort or the subscription ending may leave the loop.
            // Named in the outer scope because the catch reports it: a failure
            // before the id is read has no session to name.
            let sid: string | undefined;
            // Freeze the operation's evidence context before its first await.
            // The catch below runs after the model call, where a
            // `session.moved` may already have re-pointed this session at
            // another repository; resolving it there would stamp the failure
            // receipt of repo A's capture as repo B's evidence.
            let opGate: GateContext | undefined;
            try {
              // The turn-end event reached this subscription. Counted before
              // the session-id and cooldown checks so a delivered-but-cooled event
              // still proves the event arrived — only a zero here means no turn-end
              // event reached this instance, the only case the disposal flush records.
              turnEndSeen++;
              // The arrival receipt: one line per delivered event, written
              // synchronously before any check below can skip it, so a
              // delivered turn never leaves this loop without a trace.
              // `discard` names the loop's own skip (`no_sid`, `cooldown`);
              // `none` means the event proceeded, so a proceeding arrival
              // with no `auto_capture_start` is a cut in the band between
              // this receipt and that line — a named state, not a silence.
              // Sync best-effort like the start receipt: the line must land
              // before the host can cut the handler, and an unwritable log
              // must not cost a pass its model call. The session rides as
              // the context argument so the stamp resolves inside this
              // synchronous stretch, not after an await.
              sid = event.sessionID;
              if (sid === undefined) {
                recordSyncBestEffort("auto_capture_seen", {
                  discard: "no_sid",
                });
                continue;
              }
              setCurrent({ sessionID: sid });
              const now = Date.now();
              if (!captureCooldownPasses("idle", sid, now)) {
                recordSyncBestEffort(
                  "auto_capture_seen",
                  { discard: "cooldown" },
                  true,
                  sid,
                );
                continue; // 5-min cooldown, shared across setups
              }
              recordSyncBestEffort(
                "auto_capture_seen",
                { discard: "none" },
                true,
                sid,
              );
              // Created before the first await so cleanup can see this pass in the
              // window before the model call, still applies in full.
              const phase = newPhase();
              opGate = bindCapture(sid);
              await track(
                captureSession(sid, "", "idle", undefined, opGate, phase),
                phase,
              );
            } catch (err) {
              // Teardown is not a capture failure: after cleanup the store may
              // be gone, and a receipt here would be the ENOENT noise
              // reports. The abort check inside captureSession is the signal.
              if (controller.signal.aborted) return;
              // The console line is the primary trace and the receipt is the
              // copy: when the evidence log is the broken channel, the receipt
              // below cannot land and the underlying failure would vanish with
              // it — the counter names only the receipt event, not its cause.
              // ONE rendering feeds both, so the two channels of this one
              // failure cannot diverge in what they expose.
              const failure = safeErrorMessage(err);
              console.warn(
                `[opencode-self-improvement] auto-capture (idle) hook failed (ignored): ${failure}`,
              );
              // Fail-closed for the SESSION, never silent in the store: the
              // same silence that hid the 2.2.5 shape break would make a
              // throwing capture indistinguishable from one that never ran.
              await recordBestEffort(
                "auto_capture_refused",
                {
                  session: sid ?? "?",
                  trigger: "idle",
                  reason: "capture_threw",
                  error: failure,
                },
                true,
                sid,
                opGate?.evidenceContext,
              );
            }
          }
        } catch (err) {
          // Teardown is not an anomaly: after cleanup aborted the signal, an
          // iterator ending (returning or throwing) is the contract, not a
          // failure worth a console line.
          if (controller.signal.aborted) return;
          // Without the abort this catch is a subscription that died
          // mid-process: the iterator threw, or a future edit hoists a
          // throwing statement above the inner try. Nothing resubscribes, so
          // auto-capture is dead for the life of the process, and the receipt
          // loop that could say so is dead with it. The console line is the
          // one trace that survives a broken evidence log: a dead
          // subscription names itself there.
          console.warn(
            `[opencode-self-improvement] auto-capture (idle) subscription failed (ignored): ${safeErrorMessage(err)}`,
          );
        }
      })();
      captureCleanup = async () => {
        // The signal stops NEW passes (the subscription checks it before
        // dispatch, and the compaction seam checks it before starting). Passes
        // already started are handled by drainInFlight in two phases: abandon
        // the unanswered ones, drain the answered ones.
        controller.abort();
        await drainInFlight();
        // Disposal flush: the one capture signal that does not depend on a
        // turn-end event arriving. If an armed instance is disposed having
        // observed no turn-end event and started no pass, record that absence.
        // This line is PREDICTIVE, not observed: on current host versions the
        // turn-end event reaches the subscription in every measured run, and an
        // idle instance restarted between turns produces it too — so it names the
        // state the original report inferred, never an accusation of where a
        // dispatched event went. Best-effort and existence-checked: a disposed
        // instance must not resurrect a store its caller removed (the teardown
        // contract), and a failed heartbeat must never turn cleanup into a
        // throw.
        if (turnEndSeen === 0 && passesStarted === 0) {
          if (existsSync(evidenceDir()))
            await recordBestEffort(
              "auto_capture_dispose",
              {
                armed: true,
                turn_end_events: 0,
                passes: 0,
                reason: "no_turn_end_observed",
                subscribed: `[${host.subscribedEvents.join(",")}]`,
              },
              false,
            );
        }
      };

      // The compaction trigger needs no extra subscription: the session
      // compaction hook (registered above) calls through this seam. The
      // cooldown names the trigger, so measuring a compaction capture is
      // not confounded by an idle fire moments before - and lives at
      // module level, so a second setup() cannot double-pay one
      // compaction.
      if (captureOnCompact) {
        onCompactCapture = (sid, messages) => {
          if (controller.signal.aborted) return;
          const now = Date.now();
          if (!captureCooldownPasses("compaction", sid, now)) return; // 5-min cooldown
          // Same freeze as the idle trigger, and for the same reason: sync,
          // before guarded() starts awaiting.
          const opGate = bindCapture(sid);
          // Tracked, not just fired: cleanup must be able to drain this pass
          //, which is the only reason the seam keeps the promise.
          const phase = newPhase();
          return track(
            // The predicate, not just the checks inside the pass: a rejection
            // from the awaited model call skips every abort check that follows
            // it and lands in the generic reporter, which would append
            // `hook_error` to a store cleanup() has already released.
            guarded(
              "session.compaction (auto-capture)",
              () =>
                captureSession(
                  sid,
                  flattenTranscript(messages),
                  "compaction",
                  messages,
                  opGate,
                  phase,
                ),
              () => !controller.signal.aborted,
            ),
            phase,
          );
        };
      }
    }
  } else if (options.captureOnCompact === true) {
    // autoCapture is the master switch, so an explicit false wins over a
    // compaction trigger that was never turned off.
    console.warn(
      "[opencode-self-improvement] captureOnCompact is on but autoCapture is false; compaction capture stays disabled (autoCapture is the master switch).",
    );
  }
  return { onCompactCapture, cleanup: captureCleanup };
}
