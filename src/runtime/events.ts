// Shared lifecycle policy. The host supplies normalized events and delivery
// callbacks; setup owns the returned registration and compaction capture.
import type { CompactCapture } from "../host/capture.ts";
import { randomBytes } from "node:crypto";
import type { MemoryLifecycleHost } from "../host/lifecycle.ts";
import type { guarded as Guarded } from "../core/hooks.ts";
import type { createInjectionEpochs } from "../inject/epochs.ts";
import type { Measured } from "../status/payload.ts";
import type { HitSource } from "../telemetry/ledger.ts";
import type { Memory } from "../store/model/memory.ts";
import { useSignals } from "../telemetry/ledger.ts";
import { setCurrent } from "../core/state.ts";
import {
  bindSessionProvisional,
  rememberSessionDir,
} from "../identity/repokey.ts";
import { foldUsage } from "../status/usage.ts";
import {
  afterTool,
  markTurn,
  checkNewSession,
  onCompacting,
} from "../capture/triggers.ts";
import { recordSessionModel } from "../capture/session-model.ts";
import {
  contextualPull,
  PULL_SHIPPED,
  PULL_HEADER,
  type PullScope,
  pullQueryFor,
} from "../inject/pull.ts";
import { createPullReceipts, type PullLoss } from "../inject/pull-receipts.ts";
import { formatMemory } from "../inject/format.ts";
import { peekTurn } from "../core/state.ts";
import {
  captureEvidenceContext,
  record,
  recordBestEffort,
  safeErrorMessage,
} from "../telemetry/record.ts";
import { compactionAnchor } from "../inject/anchor.ts";

/** Placement and observation clocks for a deferred pull receipt. */
export interface RideAt {
  lockWaitMs: number;
  tool: string;
  evidence: ReturnType<typeof captureEvidenceContext>;
  placedAt: number;
  observedAt: number;
  turn?: number;
  turnKey?: string;
}

interface HookDependencies {
  guarded: typeof Guarded;
  sessions: ReturnType<typeof createInjectionEpochs>;
  instanceDir: string | undefined;
  budget: number;
  noteHits: (
    src: HitSource,
    sid: string,
    rows: Memory[],
    query: string,
    at?: RideAt,
  ) => Promise<void>;
  bindSessionIdentity: (sid: string | undefined) => Promise<void>;
  bindSessionFromApi: (sid: string | undefined) => Promise<void>;
  measuredTurns: Map<string, Measured>;
  flushStatus: (sid: string) => Promise<void>;
  /** Which tool results may carry a pull and what they search. */
  pullScope: PullScope;
  getCompactCapture: () => CompactCapture | undefined;
}

// Counts only: a lost pull names its tool and how many rows, never the rows'
// text or the tool's output. `trimmed` is the same failure `pull_undelivered`
// already names at placement, seen one step later.
async function reportPullLosses(losses: PullLoss[]): Promise<void> {
  for (const loss of losses)
    await record(
      loss.reason === "trimmed" ? "pull_undelivered" : "pull_unconfirmed",
      {
        tool: loss.held.tool,
        rows: loss.rows,
        ...(loss.reason === "trimmed"
          ? { stage: "request" }
          : { reason: loss.reason }),
      },
      false,
      loss.held.sid,
      loss.held.evidence,
    );
}

export async function registerHooks(
  host: MemoryLifecycleHost,
  {
    guarded,
    sessions,
    instanceDir,
    budget,
    noteHits,
    bindSessionIdentity,
    bindSessionFromApi,
    measuredTurns,
    flushStatus,
    pullScope = PULL_SHIPPED,
    getCompactCapture,
  }: HookDependencies,
) {
  // Pulls placed on a tool result, waiting for the request that carries them.
  const receipts = createPullReceipts();

  // Bookkeeping: track the active session/tool/call before a tool runs.
  return host.register({
    beforeTool: (event) =>
      guarded("tool.execute.before", async () => {
        setCurrent({
          sessionID: event?.sessionID,
          callID: event.callID,
          tool: event?.tool,
        });
      }),

    afterTool: (event) =>
      guarded("tool.execute.after", async () => {
        const input = {
          tool: event?.tool,
          sessionID: event?.sessionID,
          callID: event.callID,
          args: event.args,
        };
        setCurrent(input);
        // Evidence lines written below stamp the RECORDING repository. Bind
        // an unbound caller to this instance first (SYNC provisional; the
        // prompt hook / events bind firmly in production) so a tool_result
        // can never carry another instance's stamp.
        if (typeof event?.sessionID === "string") {
          bindSessionProvisional(event.sessionID, instanceDir);
        }
        const evidence = captureEvidenceContext(input.sessionID);
        const out = {
          output: event.text,
          metadata: event.metadata,
        };
        await afterTool(input, out);
        // Capture the text BEFORE the pull appends to it, so the write-back can
        // place just the appended block instead of duplicating the tool output.
        const textBefore = typeof out.output === "string" ? out.output : "";
        const header = `${PULL_HEADER} [${randomBytes(8).toString("hex")}]`;
        const pulled = await contextualPull(
          input,
          out as { output?: unknown },
          budget,
          await useSignals(),
          pullScope,
          header,
        );
        const shown =
          pulled.length > 0 && typeof out.output === "string"
            ? event.appendResult(out.output)
            : false;
        // Placed is not yet delivered: a later plugin's execute.after hook can
        // still trim this result. Hold the credit; the next request for
        // this session settles it against the tool-result it actually carries.
        // Turn and time are read NOW, so the credit names the turn the ride
        // landed on and throttles on the placement's own clock.
        const sid = String(event?.sessionID ?? "");
        const callID = typeof input.callID === "string" ? input.callID : "";
        if (shown && sid && callID) {
          const observed = peekTurn(sid);
          await reportPullLosses(
            receipts.hold({
              sid,
              callID,
              header,
              evidence,
              tool: String(event?.tool ?? ""),
              rows: pulled,
              lines: pulled.map(formatMemory),
              query: pullQueryFor(
                String(event?.tool ?? ""),
                input.args,
                textBefore,
                pullScope,
              ),
              at: Date.now(),
              turn: observed?.turn,
              turnKey: observed?.key,
            }),
          );
        } else if (shown)
          // No session or call ID: no request can be matched to this placement,
          // so it is reported and never credited.
          await record(
            "pull_unconfirmed",
            {
              tool: String(event?.tool ?? ""),
              rows: pulled.length,
              reason: "no_call",
            },
            false,
            input.sessionID,
            evidence,
          );
        else if (pulled.length)
          await record(
            "pull_undelivered",
            { tool: String(event?.tool ?? ""), rows: pulled.length },
            false,
            input.sessionID,
            evidence,
          );
      }),

    // One context hook, two guarded sections, so a failure in one cannot skip
    // the other.
    //
    // Pull receipts run first: this request's messages are what the host
    // is about to send, after every execute.after hook has run. The held pulls
    // whose tool-result reached it are credited, only for the rows whose line
    // survived. Settled synchronously on entry, so two requests cannot both
    // credit one placement; a failed ledger write is not retried from here.
    //
    // Then the tiny system digest + open-thread frontier block, injected into
    // the system prompt.
    context: async (event) => {
      await guarded("session.context (pull receipt)", async () => {
        const sid =
          typeof event?.sessionID === "string" ? event.sessionID : undefined;
        const observedAt = Date.now();
        const { credits, losses } = receipts.settle(
          sid,
          event.observedResults,
          observedAt,
        );
        // All pull receipts in this request share one lock-wait budget.
        const deadline = performance.now() + 50;
        for (const { held, rows } of credits) {
          const lockWaitMs = Math.max(
            0,
            Math.ceil(deadline - performance.now()),
          );
          await noteHits("pull", held.sid, rows, held.query, {
            lockWaitMs,
            tool: held.tool,
            evidence: held.evidence,
            placedAt: held.at,
            observedAt,
            turn: held.turn,
            turnKey: held.turnKey,
          });
        }
        await reportPullLosses(losses);
      });
      await guarded("session.context (systemDigest)", async () => {
        // Route store reads in this hook through the right session's scope:
        // the sid is captured from the event BEFORE any await and carried
        // explicitly — the global current set here is legacy bookkeeping
        // only, never the identity this flow filters with.
        const sid =
          typeof event?.sessionID === "string" ? event.sessionID : undefined;
        setCurrent({ sessionID: event?.sessionID });
        if (typeof sid === "string") sessions.touch(sid);
        // An omitted captureModel inherits the session's normalized model ref.
        if (typeof sid === "string") recordSessionModel(sid, event?.model);
        // Resolve WHOSE repository this injection reads before the store
        // read below: an unbound session would otherwise fall to global-only
        // and silently lose its own frontier rows. SYNC provisional bind to
        // this instance's workspace — the prompt hook (or an event) has
        // already bound firmly in production, so no host lookup belongs in
        // this hot path.
        if (typeof sid === "string") bindSessionProvisional(sid, instanceDir);
        if (event.appendSystem) await sessions.deliver(sid, event.appendSystem);
      });
    },

    // Memory-first injection, frozen per epoch (cache-safe). Remember the
    // latest user prompt here; the request-time context hook builds or
    // invalidates the epoch immediately before delivery. Relevance staleness
    // is accepted while the injectable rows stay unchanged, preserving a
    // stable system prefix across ordinary turns.
    // The normalized prompt is input only; the adapter owns its UI representation.
    prompt: (event) =>
      guarded("session.prompt (inject)", async () => {
        setCurrent({ sessionID: event?.sessionID });
        const sid = event?.sessionID;
        if (typeof sid === "string") {
          sessions.touch(sid);
          markTurn(sid);
          await checkNewSession(sid);
          await bindSessionIdentity(sid);
          await sessions.prompt(sid, event.text);
        }
      }),

    // Session-convergence rollup at compaction. The epoch is dropped so the
    // next prompt re-scores against the post-compaction store. Memory-aware
    // compaction: the durable-memory anchor is pushed onto the hook's system
    // context (visible to the summarizer after handlers finish) so the
    // summary preserves the facts. Also fires the context-death auto-capture
    // (issue, opt-in; see the capture section): the transcript is mined
    // while it still exists, BEFORE the summarizer replaces it.
    compact: (event) =>
      guarded("session.compaction (onCompacting)", async () => {
        const sid =
          typeof event?.sessionID === "string" ? event.sessionID : undefined;
        setCurrent({ sessionID: event?.sessionID });
        // The anchor read and the capture pass below partition by the session's
        // repository; SYNC provisional bind only — a host lookup from this
        // hook would violate the zero-token promise (see capture).
        if (typeof sid === "string") bindSessionProvisional(sid, instanceDir);
        if (event.phase !== "prepare") {
          await onCompacting({ sessionID: event?.sessionID });
          if (typeof event?.sessionID === "string") {
            sessions.invalidate(event.sessionID);
          }
        }
        // A split host already supplied context before summarization. Completion
        // must neither deliver an anchor too late nor start a second capture.
        if (event.phase === "complete") return;
        const anchor = await compactionAnchor(12, sid);
        if (anchor) event.appendSystem?.(anchor);
        // Fire-and-forget: a capture model call must never delay the compaction
        // the user is waiting for, and failures stay inside the guarded path.
        // The payload's own messages ride along so the mining sees the
        // pre-compaction transcript even if the store moves under it.
        const onCompactCapture = getCompactCapture();
        if (onCompactCapture && sid && event.capture !== false) {
          const work = onCompactCapture(sid, event.transcript);
          if (work) event.captureStarted?.(work);
        }
      }),

    identity: ({ sessionID: sid, directory: dir }) => {
      if (dir !== undefined) rememberSessionDir(sid, dir);
      else void guarded("session bind (api)", () => bindSessionFromApi(sid));
    },
    usage: async (usage) => {
      const { sessionID } = usage;
      sessions.touch(sessionID);
      const measured = foldUsage(usage, new Date().toISOString());
      measuredTurns.set(sessionID, measured);
      await recordBestEffort(
        "session_usage",
        {
          session: usage.accountingID ?? sessionID,
          observed: performance.timeOrigin + performance.now(),
          input: measured.input,
          read: measured.read,
          write: measured.write,
          output: measured.output,
          reasoning: measured.reasoning,
        },
        false,
        sessionID,
      );
      await guarded("status flush (measured)", () => flushStatus(sessionID));
    },
    error: (err) => {
      console.warn(
        `[opencode-self-improvement] lifecycle subscription or cleanup failed (ignored): ${safeErrorMessage(err)}`,
      );
    },
  });
}
