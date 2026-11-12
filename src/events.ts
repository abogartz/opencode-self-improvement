// Host hook registration and measured-usage listener (#168). Setup owns the
// returned controller and supplies the live compaction-capture callback.
import type { PluginCtx } from "./core/host.ts";
import type { guarded as Guarded } from "./core/hooks.ts";
import type { createInjectionEpochs } from "./inject/epochs.ts";
import type { Measured } from "./status/payload.ts";
import type { HitSource } from "./hits/ledger.ts";
import type { Memory } from "./store/model/memory.ts";
import { useSignals } from "./hits/ledger.ts";
import { setCurrent } from "./core/state.ts";
import {
  bindSessionProvisional,
  rememberSessionDir,
} from "./identity/repokey.ts";
import {
  sessionIdentityEvent,
  sessionUsageEvent,
  foldUsage,
} from "./identity/host-events.ts";
import {
  afterTool,
  markTurn,
  checkNewSession,
  onCompacting,
} from "./capture/triggers.ts";
import { recordSessionModel } from "./capture/session-model.ts";
import { contextualPull } from "./inject/pull.ts";
import { pullQuery } from "./recall/relevant.ts";
import { compactionAnchor } from "./inject/anchor.ts";

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
  ) => Promise<void>;
  bindSessionIdentity: (sid: string | undefined) => Promise<void>;
  bindSessionFromApi: (sid: string | undefined) => Promise<void>;
  measuredTurns: Map<string, Measured>;
  flushStatus: (sid: string) => Promise<void>;
  getCompactCapture: () =>
    | ((sid: string, messages: unknown) => void)
    | undefined;
}

// Best-effort extraction of a tool's textual output + metadata from the V2
// execute.after `result` payload, whose exact encoding varies by tool.
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  for (const k of ["output", "text", "content", "stdout"]) {
    const v = r[k];
    if (typeof v === "string") return v;
  }
  if (Array.isArray(r.content)) {
    return (r.content as Array<Record<string, unknown>>)
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
function resultMeta(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object") {
    const m = (result as Record<string, unknown>).metadata;
    if (m && typeof m === "object") return m as Record<string, unknown>;
  }
  return {};
}

export async function registerHooks(
  ctx: PluginCtx,
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
    getCompactCapture,
  }: HookDependencies,
) {
  // Bookkeeping: track the active session/tool/call before a tool runs.
  await ctx.tool?.hook("execute.before", (event: any) =>
    guarded("tool.execute.before", async () => {
      setCurrent({
        sessionID: event?.sessionID,
        callID: event?.callID ?? event?.id,
        tool: event?.tool,
      });
    }),
  );

  await ctx.tool?.hook("execute.after", (event: any) =>
    guarded("tool.execute.after", async () => {
      const input = {
        tool: event?.tool,
        sessionID: event?.sessionID,
        callID: event?.callID ?? event?.id,
        args: event?.input,
      };
      setCurrent(input);
      // Evidence lines written below stamp the RECORDING repository. Bind
      // an unbound caller to this instance first (SYNC provisional; the
      // prompt hook / events bind firmly in production) so a tool_result
      // can never carry another instance's stamp (#127).
      if (typeof event?.sessionID === "string") {
        bindSessionProvisional(event.sessionID, instanceDir);
      }
      const out = {
        output: resultText(event?.result),
        metadata: resultMeta(event?.result),
      };
      await afterTool(input, out);
      const pulled = await contextualPull(
        input,
        out as { output?: unknown },
        budget,
        await useSignals(),
      );
      if (pulled.length)
        await noteHits(
          "pull",
          String(event?.sessionID ?? ""),
          pulled,
          pullQuery(input.args),
        );
      // Write a contextual-pull append back when the tool result is text we own.
      if (
        event?.result &&
        typeof event.result === "object" &&
        typeof event.result.content === "string"
      ) {
        const text = resultText(event.result);
        if (out.output && out.output !== text)
          event.result.content = out.output;
      }
    }),
  );

  // Tiny system digest + open-thread frontier block, injected into the system prompt.
  await ctx.session?.hook("context", (event: any) =>
    guarded("session.context (systemDigest)", async () => {
      // Route store reads in this hook through the right session's scope:
      // the sid is captured from the event BEFORE any await and carried
      // explicitly — the global current set here is legacy bookkeeping
      // only, never the identity this flow filters with (#127).
      const sid =
        typeof event?.sessionID === "string" ? event.sessionID : undefined;
      setCurrent({ sessionID: event?.sessionID });
      if (typeof sid === "string") sessions.touch(sid);
      // #139: SessionRequest declares a readonly model, so the host already
      // tells us which model this session runs on. Remember it: an omitted
      // captureModel inherits it in capture/runtime.ts.
      if (typeof sid === "string") recordSessionModel(sid, event?.model);
      // Resolve WHOSE repository this injection reads before the store
      // read below: an unbound session would otherwise fall to global-only
      // and silently lose its own frontier rows. SYNC provisional bind to
      // this instance's workspace — the prompt hook (or an event) has
      // already bound firmly in production, so no host lookup belongs in
      // this hot path (#127).
      if (typeof sid === "string") bindSessionProvisional(sid, instanceDir);
      await sessions.deliver(sid, (text) =>
        event?.system?.push?.({ type: "text", text }),
      );
    }),
  );

  // Memory-first injection, frozen per epoch (cache-safe). Remember the
  // latest user prompt here; the request-time context hook builds or
  // invalidates the epoch immediately before delivery. Relevance staleness
  // is accepted while the injectable rows stay unchanged, preserving a
  // stable system prefix across ordinary turns.
  // Never mutate event.prompt.text — it is stored verbatim and rendered in
  // the UI.
  await ctx.session?.hook("prompt", (event: any) =>
    guarded("session.prompt (inject)", async () => {
      setCurrent({ sessionID: event?.sessionID });
      const sid = event?.sessionID;
      if (typeof sid === "string") {
        sessions.touch(sid);
        markTurn(sid);
        await checkNewSession(sid);
        await bindSessionIdentity(sid);
        await sessions.prompt(sid, event?.prompt?.text ?? "");
      }
    }),
  );

  // Session-convergence rollup at compaction. The epoch is dropped so the
  // next prompt re-scores against the post-compaction store. Memory-aware
  // compaction: the durable-memory anchor is pushed onto the hook's system
  // parts (visible to the summarizer model, which runs AFTER hooks) so the
  // summary preserves the facts. Never sets event.result — that would skip
  // the summarizer call entirely. Also fires the context-death auto-capture
  // (issue #41, opt-in; see the capture section): the transcript is mined
  // while it still exists, BEFORE the summarizer replaces it.
  await ctx.session?.hook("compaction", (event: any) =>
    guarded("session.compaction (onCompacting)", async () => {
      const sid =
        typeof event?.sessionID === "string" ? event.sessionID : undefined;
      setCurrent({ sessionID: event?.sessionID });
      // The anchor read and the capture pass below partition by the session's
      // repository; SYNC provisional bind only — a host lookup from this
      // hook would violate the zero-token promise (#127, see capture).
      if (typeof sid === "string") bindSessionProvisional(sid, instanceDir);
      await onCompacting({ sessionID: event?.sessionID });
      if (typeof event?.sessionID === "string") {
        sessions.invalidate(event.sessionID);
      }
      const anchor = await compactionAnchor(12, sid);
      if (anchor) event?.system?.push?.({ type: "text", text: anchor });
      // Fire-and-forget: a capture model call must never delay the compaction
      // the user is waiting for, and failures stay inside the guarded path.
      // The payload's own messages ride along so the mining sees the
      // pre-compaction transcript even if the store moves under it.
      const onCompactCapture = getCompactCapture();
      if (onCompactCapture && sid) {
        onCompactCapture(sid, event.messages);
      }
    }),
  );

  // ---- measured prompt-cache health (usage events) -----------------------
  // Zero-model by design: usage arrives on `session.usage.updated` (v2 hosts)
  // or `message.updated` assistant info (older hosts), carrying tokens
  // {input, output, reasoning, cache.read/write}; the session-wide
  // read/(read+input+write) share is the honest receipt behind the
  // byte-stability proxy. Streaming updates arrive repeatedly — overwriting
  // with the latest is correct because the final update carries the complete
  // usage. Flushes the per-session status file so the TUI badge refreshes
  // once per turn instead of per step. Degrades to "not measured" when the
  // host exposes no event stream.
  const measuredController = new AbortController();
  if (ctx.event?.subscribe) {
    const eventApi = ctx.event;
    void (async () => {
      try {
        for await (const raw of eventApi.subscribe({
          signal: measuredController.signal,
        })) {
          // Session identity: created fires for new sessions, execution.started
          // every turn (covers sessions resumed across a restart), moved on a
          // workspace change. Stamps and visibility resolve through this.
          const identity = sessionIdentityEvent(raw);
          if (identity) {
            const { sessionID: sid, directory: dir } = identity;
            if (dir !== undefined) rememberSessionDir(sid, dir);
            // 2.1.4 serve sends execution.started with no location at all:
            // resolve the session row instead of leaving the session unbound.
            else
              void guarded("session bind (api)", () => bindSessionFromApi(sid));
            continue;
          }
          const usage = sessionUsageEvent(raw);
          if (!usage) continue;
          const { sessionID } = usage;
          sessions.touch(sessionID);
          // #394 review: fold, do not overwrite — on the compatibility path a
          // receipt is per-message, and the last message is not the session.
          measuredTurns.set(
            sessionID,
            foldUsage(usage, new Date().toISOString()),
          );
          await guarded("status flush (measured)", () =>
            flushStatus(sessionID),
          );
        }
      } catch {
        // the subscription ended (abort or host error); nothing to do
      }
    })();
  }

  return measuredController;
}
