// opencode-self-improvement: one opencode plugin bundling durable memory, the
// 4-gate write pipeline, deterministic reflection triggers T1/T2/T4,
// tiny-digest injection with deterministic memory-first context and
// contextual pull, and snapshot/rollback.
//
// Registers tools via `ctx.tool.transform` (JSON Schema) and hooks via the
// OpenCode V2 session/tool API. Slash commands are installed as markdown by
// src/command.ts. The default export `{ id, setup(ctx) }` is checked against
// the SDK's Plugin type using a type-only import (see the note on `plugin`).
import type { Cleanup, Plugin } from "@opencode/plugin/promise/plugin";
import { basename, join } from "node:path";
import { frontierBudget, injectBudget } from "./core/config/budgets.ts"
import { memoryRoot } from "./core/config/paths.ts";
import { unresolvedWriteMessage } from "./store/files/append.ts"
import { loadAll, malformedCount } from "./store/files/load.ts"
import { snapshotFiles } from "./store/files/snapshots.ts"
import { clearSuperseded, markManySuperseded, markSuperseded } from "./store/files/supersede.ts"
import { resolveMemoryTarget } from "./store/files/target.ts"
import { type Memory } from "./store/model/memory.ts"
import { isActive, isInjectable } from "./store/model/predicates.ts"
import { evidenceVisibleTo, isVisibleTo, readerFromSid } from "./store/model/visibility.ts";
import { auditCaveat, runWriteGate, sameStrList, type GateContext, type WriteCandidate } from "./gate/gate.ts";
import { withStoreLock } from "./store/lock.ts";
import { isQuarantined, quarantineCandidate, quarantineReasons } from "./store/quarantine/quarantine.ts";
import { pruneMemory } from "./store/prune.ts";
import { findStaleOpen } from "./portable/decay.ts"
import { exportMemories } from "./portable/export.ts"
import { importMemories } from "./portable/import.ts";
import { listSnapshots, restoreSnapshot } from "./store/undo.ts";
import { SESSION_CAP, SessionLru } from "./core/lru.ts";
import { captureEvidenceContext, evidenceFileFor, record, recordCaptureLag } from "./evidence/record.ts";
import { proposeConsolidations } from "./consolidate/propose.ts"
import { renderProposals } from "./consolidate/render.ts";
import { readReads } from "./hits/ledger.ts";
import { compactionAnchor } from "./inject/anchor.ts"
import { formatMemory } from "./inject/format.ts"
import { contextualPull } from "./inject/pull.ts"
import { pullQuery } from "./recall/relevant.ts"
import { sharedTerms } from "./recall/shared-terms.ts";
import { createInjectionEpochs } from "./inject/epochs.ts";
import { registerMemoryTools } from "./tools/registry.ts";
import { readLedger, neverRetrieved, recordHits, useSignals, type HitSource } from "./hits/ledger.ts";
import { formatInit } from "./init/format.ts"
import { runInit } from "./init/run.ts";
import { ensureInitCommand, ensureMemoryReportCommand } from "./command/ensure.ts";
import { captureLag, captureLagLines, rowsPerDay } from "./status/metrics.ts"
import { type Measured, type StoreCounts } from "./status/payload.ts"
import { renderMemoryReport } from "./status/report.ts"
import { blockedRecent } from "./status/write.ts";
import {
  afterTool,
  checkNewSession,
  writeEvidence,
  firstFrontierTap,
  hasEngagement,
  hasGateCheck,
  markFrontierTap,
  markTurn,
  onCompacting,
} from "./capture/triggers.ts";
import { getCurrent, setCurrent } from "./core/state.ts";
import { resolveRepo, setRepoScope, rememberSessionDir, sessionDir, sessionDirFirm, bindSessionProvisional, writeTarget } from "./identity/repokey.ts";
import { parseLine } from "./core/logfmt/format.ts"
import { readLines } from "./core/logfmt/read.ts";
import { parseCandidates, parseModelRef } from "./capture/candidates.ts"
import { lagSince } from "./capture/lag.ts"
import { buildCapturePrompt } from "./capture/prompt.ts"
import { flattenTranscript } from "./capture/transcript.ts";
import { redactSecrets } from "./store/secrets.ts";
import { flattenMemoryText } from "./store/sanitize.ts";
import { bunFloorWarning } from "./core/runtime.ts";
import {
  captureSessionID,
  sessionDirectoryFromMessages,
  sessionDirectoryFromRow,
  sessionIdentityEvent,
  sessionUsageEvent,
  toolIdentity,
} from "./identity/host-events.ts";

// Tool/input boundaries are zod schemas (src/schema.ts): the JSON Schema the
// host sees is GENERATED from them, and raw args are re-parsed at execution.
import {
  DecayArgs,
  EmptyArgs,
  EvidenceArgs,
  ExportArgs,
  ForgetArgs,
  ImportArgs,
  InitArgs,
  ConsolidateArgs,
  MergeReviewArgs,
  RecallArgs,
  RememberArgs,
  UndoArgs,
  UpdateArgs,
  validated,
} from "./tools/schema.ts";

// --- OpenCode V2 runtime shapes (loose: we only read a few fields) ----------
interface ToolDef {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options?: { codemode?: boolean; namespace?: string };
  execute: (args: any, context: any) => Promise<{ content: string }>;
}
interface ToolEditorLike {
  add: (tool: ToolDef) => void;
}
interface HookReg {
  dispose?: () => Promise<void> | void;
}
interface PluginCtx {
  location?: { directory?: string };
  options?: Record<string, unknown>;
  tool?: {
    transform: (cb: (editor: ToolEditorLike) => void) => Promise<unknown>;
    hook: (name: string, cb: (event: any) => Promise<void> | void) => Promise<HookReg | void>;
  };
  session?: {
    hook: (name: string, cb: (event: any) => Promise<void> | void) => Promise<HookReg | void>;
    context?: (input: { sessionID: string }) => Promise<unknown>;
    get?: (input: { sessionID: string }) => Promise<unknown>;
  };
  event?: {
    subscribe: (o?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
  };
  generate?: {
    text: (input: unknown) => Promise<{ text?: string } | string>;
  };
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

const PLUGIN_ID = "opencode-self-improvement";

// Tag on store rows captured by the COMPACTION trigger (issue #41). Rows keep
// the shared "auto-capture" provenance tag (src/inject.ts renders it) and add
// this one so decay/status can tell which trigger wrote them — the same
// distinction the auto_capture_compaction_* evidence lines carry.
const CAPTURE_COMPACT_TAG = "auto_capture_compaction";

// The setup-time Bun-floor warning fires once per process (setup can run for
// more than one location).
let bunFloorChecked = false;

// Auto-capture cooldown, shared by EVERY setup() registration (#108): setup
// runs for more than one location, and per-closure cooldown maps made those
// registrations strangers - one compaction could pay for two model calls on
// one transcript. Same module-level shape as `turns` in src/lock.ts; the key
// names the trigger, so measuring one trigger is still not confounded by the
// other having fired moments ago.
const lastCaptureRun = new Map<string, number>();

const CAPTURE_COOLDOWN_MS = 5 * 60_000;

/** True if this trigger may fire for this session now; records the fire. */
function captureCooldownPasses(trigger: "idle" | "compaction", sid: string, now: number): boolean {
  const key = `${trigger}:${sid}`;
  if (now - (lastCaptureRun.get(key) ?? 0) < CAPTURE_COOLDOWN_MS) return false;
  // Sessions churn and a long-lived server must not grow one entry per
  // session forever; oldest-inserted go first (the ledger throttle's rule).
  if (lastCaptureRun.size > 2000) {
    for (const k of [...lastCaptureRun.keys()].slice(0, 1000)) lastCaptureRun.delete(k);
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
export const TURN_END_EVENTS = ["session.execution.succeeded", "session.execution.interrupted"] as const;

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
  return typeof type === "string" && (TURN_END_EVENTS as readonly string[]).includes(type);
}

// The real setup implementation, written against the loose local PluginCtx
// (the only members of the V2 context this plugin actually touches).
const impl = {
  async setup(ctx: PluginCtx): Promise<Cleanup | void> {
    // Identity vs verification tree are separate concerns: the repo STAMP is
    // resolved per session from the event stream (never from process.cwd(),
    // which is the server launch dir and poisons rows invisibly); cwd remains
    // only as the gate's verification tree when no session location is known.
    const setupRoot = ctx?.location?.directory;
    const liveRoot = setupRoot ?? process.cwd();
    setRepoScope(setupRoot ? resolveRepo(setupRoot) : null);
    // THIS instance's own workspace. The module scope says who loaded last;
    // this says who I am. An unbound session that calls into THIS instance
    // resolves here — never to another instance's scope (#127, multi-setup).
    const instanceDir = typeof setupRoot === "string" && setupRoot ? setupRoot : undefined;

    // Character budgets: relevance injection and contextual pulls share the
    // existing cap; the session-start frontier has its own larger cap. Plugin
    // options win over env fallbacks, and the frontier defaults to 3x the
    // effective injection budget.
    const budget = Number(ctx.options?.injectBudget) || injectBudget();
    const openBudget = Number(ctx.options?.frontierBudget) || frontierBudget(budget);

    // Warn-once Bun floor check (same setup-time warning style as the
    // captureModel warnings below): opencode embeds Bun, and the store code's
    // fs failure modes are Bun-version dependent, so flag an old host.
    if (!bunFloorChecked) {
      bunFloorChecked = true;
      const floorWarning = bunFloorWarning(typeof Bun === "undefined" ? undefined : Bun.version);
      if (floorWarning) console.warn(floorWarning);
    }

    // Mirror the /repo-init slash command into opencode's global commands dir
    // (idempotent, write-if-missing). OpenCode 2.x loads `*.md` from
    // ~/.config/opencode/commands, so this is the canonical V2 install path.
    await ensureInitCommand();
    await ensureMemoryReportCommand();

    // Fail-closed hook guard: the plugin's own bookkeeping can never take down a
    // tool call, the system transform, or compaction.
    async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
      try {
        await fn();
      } catch (err) {
        console.warn(`[opencode-self-improvement] ${name} hook failed (ignored):`, err);
      }
    }

    const gateContext = (sid?: string): GateContext => {
      // Every session-scoped member resolves for the CALLER's session when it
      // knows one (#116): capture awaits a model call between setCurrent and
      // persistence, and on a multi-session server the global current moves
      // during that await. Falling back to getCurrent() is exactly today's
      // behavior for callers whose current IS their session (tool hooks).
      const bound = sid ?? getCurrent().sid;
      return {
        sessionID: sid,
        reader: readerFromSid(sid),
        writeAt: writeTarget(bound),
        evidenceContext: captureEvidenceContext(sid),
        // NOTE (re-review): this one lookup is intentionally NON-firm — a
        // provisional binding may supply the gate's verification TREE. The
        // tree is where a referenced file is checked to exist, not who the
        // caller is: "as far as the flow can know" is the right confidence
        // level, and a wrong guess fails a code-reference gate loudly rather
        // than leaking across repositories. Identity itself never resolves
        // through here (readers and stamps use the firm-or-provisional split
        // in repokey/memory); do not mistake this for one.
        liveRoot: sessionDir(bound) ?? liveRoot,
        ...writeEvidence(bound),
        hasGateCheck: hasGateCheck(bound),
        hasEngagement: hasEngagement(bound),
      };
    };

    // A durable write needs an OWNER (#152). Reads already fail closed for a
    // session whose repository never resolved — it sees global rows and nothing
    // else — so such a session may not write either: the alternatives were the
    // last setup's repository or an unstamped (hence global) row. This answers
    // at the entry, where the model can be told what to do, and records the
    // refusal so "why is nothing stored" is answerable from memory_evidence.
    // appendMemory throws the same rule at the choke point; the two share one
    // message so they cannot drift.
    const ownerlessWriter = (sid: string | undefined): string | null => {
      const target = writeTarget(sid);
      return target.ok ? null : target.sid;
    };

    const refuseOwnerlessWrite = async (sid: string, op: string): Promise<{ content: string }> => {
      await record("write_refused", { op }, true, sid);
      return { content: unresolvedWriteMessage(sid) };
    };

    // Identity of a tool call, captured SYNCHRONOUSLY at the tool's entry —
    // the first await of the call comes after this. The V2 host hands every
    // execute a per-call ToolContext carrying sessionID; the harness and any
    // host that omits it fall back to the ambient current, which is correct
    // exactly because execute.before ran immediately before this tool with
    // no await between (#116's documented fallback). Never re-read the global
    // after an await to learn who is calling (#127).
    const toolIds = (context?: unknown): { sid: string; call: string } => {
      const { sessionID: fromCtx, callID: call } = toolIdentity(context);
      // Entry binding: a session this instance has never seen is resolved to
      // THIS workspace (provisional — a firm event/API identity still
      // replaces it), so the tool's reader partitions by the repository the
      // call reached, not by the last setup's module scope (#127).
      if (fromCtx && fromCtx !== "?") {
        bindSessionProvisional(fromCtx, instanceDir);
      }
      return {
        sid: fromCtx ?? getCurrent().sid,
        call: call ?? getCurrent().call,
      };
    };

    // Identity-event race backstop: a resumed session's FIRST turn can write
    // before the subscription has delivered its execution.started, and the
    // module-scope fallback is the last setup instance — possibly another
    // workspace. Bind once from the session context API for unmapped sids —
    // but note host 2.1.4 sends message payloads WITHOUT any location field,
    // so this path is a legacy-shape best-effort; the session-row fallback
    // below is what actually resolves serve-host sessions.
    // One-shot: never overwrites an event-bound entry.
    const bindingSids = new Set<string>();
    async function bindSessionFromMessages(sid: string | undefined): Promise<void> {
      if (!sid || sid === "?" || sessionDirFirm(sid) || bindingSids.has(sid)) return;
      bindingSids.add(sid);
      try {
        const msgs = await ctx.session?.context?.({ sessionID: sid });
        const dir = sessionDirectoryFromMessages(msgs);
        if (dir !== undefined) rememberSessionDir(sid, dir);
      } catch {
        // no context access or host error: the event stream still binds later
      } finally {
        bindingSids.delete(sid);
      }
    }

    // Serve-host reality (recorded on 2.1.4 `serve --service`): the plugin
    // instance loads AFTER the session was created, so `session.created` — the
    // only event carrying a location — is never delivered; `execution.started`
    // arrives with just {sessionID}. The session ROW is the remaining source
    // of truth: the host's session get returns `location.directory`. One
    // lookup per session; a miss is remembered so a host without the API is
    // not re-asked on every turn (bounded LRU, same cap as the scope cache).
    const apiBindTried = new Set<string>();
    const apiBindOrder = new SessionLru(SESSION_CAP, (evicted) => apiBindTried.delete(evicted));
    async function bindSessionFromApi(sid: string | undefined): Promise<void> {
      if (!sid || sid === "?" || sessionDirFirm(sid) || apiBindTried.has(sid)) return;
      apiBindTried.add(sid);
      apiBindOrder.touch(sid);
      try {
        const got = await ctx.session?.get?.({ sessionID: sid });
        const dir = sessionDirectoryFromRow(got);
        if (dir !== undefined) rememberSessionDir(sid, dir);
      } catch {
        // no session.get on this host (or unknown session): stay unbound
      }
    }

    // Identity must resolve BEFORE a row is stamped or a read is partitioned:
    // try the (legacy) message payloads, then the session row. A session the
    // host cannot describe (fresh, or a host without the lookup) is bound to
    // THIS instance's workspace — the caller's repository as the flow knows
    // it, and strictly better than an unbound read inheriting the module
    // scope of whoever loaded last (#127's multi-setup residue).
    async function bindSessionIdentity(sid: string | undefined): Promise<void> {
      if (!sid || sid === "?" || sessionDirFirm(sid)) return;
      await bindSessionFromMessages(sid);
      if (!sessionDirFirm(sid)) await bindSessionFromApi(sid);
      bindSessionProvisional(sid, instanceDir);
    }

    // ---- tools --------------------------------------------------------------
    // Use ledger (#42). `query` is what retrieval was asked with; what gets
    // stored is the vocabulary the answer SHARES with the query, taken from the
    // memory side, so the ledger can never become a copy of user prompts.
    // Fail-soft inside recordHits: telemetry must not break a read path.
    const noteHits = async (src: HitSource, sid: string, rows: Memory[], query: string): Promise<void> => {
      if (!rows.length || !query.trim()) return;
      const terms: string[] = [];
      for (const m of rows) for (const t of sharedTerms(query, m)) if (!terms.includes(t)) terms.push(t);
      await recordHits(src, sid, rows, terms);
    };
    // The host listener owns measured usage; the epoch controller drops it
    // alongside its own maps when the shared session LRU evicts an entry.
    const measuredTurns = new Map<string, Measured>();
    const sessions = createInjectionEpochs({
      budget,
      frontierBudget: openBudget,
      measuredTurns,
      noteHits: (sid, rows, query) => noteHits("inject", sid, rows, query),
    });
    const flushStatus = sessions.flushStatus;

    await ctx.tool?.transform((editor) =>
      registerMemoryTools(editor, {
        toolIds,
        bindSessionIdentity,
        ownerlessWriter,
        refuseOwnerlessWrite,
        gateContext,
        sessions,
        noteHits,
        direct: { codemode: false } as const,
      }),
    );
    // ---- hooks (all fail-closed) -------------------------------------------
    // Seam set by the auto-capture wiring below ONLY when the compaction
    // trigger is live (autoCapture on, captureOnCompact not false, valid
    // captureModel). The compaction hook calls it fire-and-forget; undefined
    // means "off". Declared here because the hook registers before capture.
    let onCompactCapture: ((sid: string, messages: unknown) => void) | undefined;

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
        const out = { output: resultText(event?.result), metadata: resultMeta(event?.result) };
        await afterTool(input, out);
        const pulled = await contextualPull(input, out as { output?: unknown }, budget, await useSignals());
        if (pulled.length) await noteHits("pull", String(event?.sessionID ?? ""), pulled, pullQuery(input.args));
        // Write a contextual-pull append back when the tool result is text we own.
        if (event?.result && typeof event.result === "object" && typeof event.result.content === "string") {
          const text = resultText(event.result);
          if (out.output && out.output !== text) event.result.content = out.output;
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
        const sid = typeof event?.sessionID === "string" ? event.sessionID : undefined;
        setCurrent({ sessionID: event?.sessionID });
        if (typeof sid === "string") sessions.touch(sid);
        // Resolve WHOSE repository this injection reads before the store
        // read below: an unbound session would otherwise fall to global-only
        // and silently lose its own frontier rows. SYNC provisional bind to
        // this instance's workspace — the prompt hook (or an event) has
        // already bound firmly in production, so no host lookup belongs in
        // this hot path (#127).
        if (typeof sid === "string") bindSessionProvisional(sid, instanceDir);
        await sessions.deliver(sid, (text) => event?.system?.push?.({ type: "text", text }));
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
        const sid = typeof event?.sessionID === "string" ? event.sessionID : undefined;
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
          for await (const raw of eventApi.subscribe({ signal: measuredController.signal })) {
            // Session identity: created fires for new sessions, execution.started
            // every turn (covers sessions resumed across a restart), moved on a
            // workspace change. Stamps and visibility resolve through this.
            const identity = sessionIdentityEvent(raw);
            if (identity) {
              const { sessionID: sid, directory: dir } = identity;
              if (dir !== undefined) rememberSessionDir(sid, dir);
              // 2.1.4 serve sends execution.started with no location at all:
              // resolve the session row instead of leaving the session unbound.
              else void guarded("session bind (api)", () => bindSessionFromApi(sid));
              continue;
            }
            const usage = sessionUsageEvent(raw);
            if (!usage) continue;
            const { sessionID, input, read, write } = usage;
            sessions.touch(sessionID);
            measuredTurns.set(sessionID, {
              at: new Date().toISOString(),
              input,
              read,
              write,
            });
            await guarded("status flush (measured)", () => flushStatus(sessionID));
          }
        } catch {
          // the subscription ended (abort or host error); nothing to do
        }
      })();
    }

    // ---- opt-in auto-capture (idle + compaction triggers) ------------------
    // Default OFF: capture never reads sessions and never calls a model. (The
    // measured-cache listener above does subscribe to the event stream by
    // default, but it is zero-model: pure bookkeeping of message usage.) When
    // enabled (options.autoCapture === true AND a valid captureModel), each
    // supported turn-end event — and, unless captureOnCompact === false, each
    // compaction hook call too — runs ONE cheap ctx.generate.text call whose
    // reply is parsed into candidates that go through the SAME runWriteGate as
    // model-authored writes — capture can never bypass the moat, and it only
    // ever writes through the gate. A per-session, per-trigger cooldown bounds
    // the cost. Compaction-triggered rows carry the CAPTURE_COMPACT_TAG tag and
    // auto_capture_compaction_* evidence lines, idle rows keep auto_capture_*,
    // so decay/status — and bench/capture-trigger-compare.ts — can measure
    // which trigger earns its tokens. Every failure is swallowed: capture must
    // never be able to break a session.
    let captureCleanup: Cleanup | undefined;
    if (ctx.options?.autoCapture === true) {
      const captureModel =
        typeof ctx.options.captureModel === "string" ? ctx.options.captureModel : "";
      const captureMax = Number(ctx.options.captureMax) || 3;
      const captureOnCompact = ctx.options?.captureOnCompact !== false;
      const modelRef = parseModelRef(captureModel);
      if (!modelRef) {
        // Invalid/missing model: skip registering the whole subscription
        // rather than guess (and warn once, at setup).
        console.warn(
          `[opencode-self-improvement] autoCapture is on but captureModel ${JSON.stringify(captureModel)} is invalid (expected "provider/id"); auto-capture disabled.`,
        );
      } else if (!ctx.event?.subscribe || !ctx.generate?.text || !ctx.session?.context) {
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
        const contextFn = (input: { sessionID: string }) => ctx.session?.context?.(input);

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
          // #152: an instance with no workspace cannot say which repository the
          // mined rows belong to, and rows with no owner are exactly what the
          // store refuses. Skip BEFORE the model call — no tokens spent on a
          // capture that cannot be stored — and leave the reason in evidence.
          if (!writeTarget(sid).ok) {
            await record("auto_capture_refused", { session: sid, trigger }, true, sid, captureGate.evidenceContext);
            return;
          }
          let transcript = seeded;
          let msgs = seededMsgs;
          if (transcript.length < 200) {
            msgs = await contextFn({ sessionID: sid });
            transcript = flattenTranscript(msgs);
          }
          if (transcript.length < 200) return; // too thin to mine reliably
          // #44: how stale is a capture? Distance from the newest message of
          // the mined transcript to this instant - measured on whatever the
          // trigger actually mined (the hook payload for compaction, the
          // session context for idle), so both triggers' lag is comparable.
          const lagMs = lagSince(msgs);
          const out = await generateApi.text({
            model: modelRef,
            // Redact the COMPLETE transcript, THEN apply the character budget
            // (#132). Cropping first can start the window INSIDE a credential:
            // a PEM body whose BEGIN marker fell off, or a token whose prefix
            // fell off, matches no pattern — buildCapturePrompt's own scrub
            // (kept, defense in depth) cannot recognize a fragment.
            prompt: buildCapturePrompt(redactSecrets(transcript).slice(-8000), captureMax),
          });
          const text = typeof out === "string" ? out : out?.text ?? "";
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
              await record(durable.length ? "auto_capture_partial" : "auto_capture_refused", {
                session: sid, trigger, type: c.type, scope: redactSecrets(c.scope),
                reason: String(err), retired: durable.join(",") || undefined,
              }, false, sid, captureGate.evidenceContext);
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
              },
              false,
              sid,
              captureGate.evidenceContext,
            );
          }
          await recordCaptureLag(sid, lagMs, candidates.length ? "candidates" : "empty", captureGate.evidenceContext);
        }

        void (async () => {
          try {
            for await (const raw of eventApi.subscribe({ signal: controller.signal })) {
              if (!captureTriggerFor(raw)) continue;
              const sid = captureSessionID(raw);
              if (sid === undefined) continue;
              setCurrent({ sessionID: sid });
              const now = Date.now();
              if (!captureCooldownPasses("idle", sid, now)) continue; // 5-min cooldown, shared across setups
              try {
                await captureSession(sid, "", "idle");
              } catch {
                // fail-closed: a broken capture attempt is invisible to the session
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
              captureSession(sid, flattenTranscript(messages), "compaction", messages),
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
    // ---- startup heartbeat (#138) ------------------------------------------
    // Every other evidence line is written BY something that already worked,
    // so "capture is off", "capture is misconfigured" and "capture is armed and
    // inert" were indistinguishable from anything a user could read - which is
    // exactly how a pipeline that had never run in ten days survived a review
    // and a merge. This one line makes the ABSENCE of capture activity
    // interpretable: `capture=` names why, `subscribed=` lists the event types
    // the subscription actually reacts to. Guarded like every other hook: a
    // broken store must not turn plugin load into a throw.
    await guarded("plugin_load heartbeat", async () => {
      let pluginVersion = "unknown";
      try {
        const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
        if (typeof pkg?.version === "string") pluginVersion = pkg.version;
      } catch {
        // a heartbeat with an unknown version still beats no heartbeat
      }
      const wantCapture = ctx.options?.autoCapture === true;
      const modelOk = !!parseModelRef(
        typeof ctx.options?.captureModel === "string" ? ctx.options.captureModel : "",
      );
      const capabilities = ["event.subscribe", "generate.text", "session.context"].filter((name) => {
        const [domain, method] = name.split(".");
        return typeof (ctx as unknown as Record<string, any>)?.[domain]?.[method] === "function";
      });
      const captureState = !wantCapture
        ? "off"
        : !modelOk
          ? "invalid_model"
          : capabilities.length < 3
            ? "no_capabilities"
            : "on";
      await record(
        "plugin_load",
        {
          version: pluginVersion,
          capture: captureState,
          capture_on_compact: ctx.options?.captureOnCompact !== false,
          capabilities: `[${capabilities.join(",")}]`,
          subscribed: `[${CAPTURE_EVENT_TYPES.join(",")}]`,
          inject_budget: injectBudget(),
          store_rows: (await loadAll()).length,
        },
        false,
      );
    });
    // Single cleanup returned by setup: tears down the measured listener and,
    // when enabled, the capture subscription. Future teardowns merge in here.
    return () => {
      measuredController.abort();
      if (captureCleanup) return captureCleanup();
    };
  },
};

// The plain object IS the V2 contract ({ id, setup }); the SDK's `Plugin` type
// pins its shape at compile time. The import is deliberately type-only:
// opencode installs npm plugins with runtime dependencies only, so a value
// import of @opencode/plugin —
// a devDependency here — would fail to resolve at load time for published
// consumers, and making it a runtime dependency would pull effect +
// @opencode/client into every install, the exact dead-weight problem dropping
// the V1 SDK fixes. `Plugin.define` is an identity function at runtime, so this
// annotation buys the same compile-time contract for zero runtime cost.
const plugin: Plugin = {
  id: PLUGIN_ID,
  setup: async (ctx) => impl.setup(ctx as unknown as PluginCtx),
};

export const SelfImprovement = plugin;
export default plugin;
