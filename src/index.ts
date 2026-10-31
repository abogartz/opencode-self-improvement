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
import { frontierBudget, injectBudget, memoryRoot } from "./config.ts";
import {
  clearSuperseded,
  evidenceVisibleTo,
  isActive,
  isVisibleTo,
  loadAll,
  malformedCount,
  markManySuperseded,
  markSuperseded,
  readerFromSid,
  resolveMemoryTarget,
  snapshotFiles,
  unresolvedWriteMessage,
  type Memory,
} from "./memory.ts";
import { auditCaveat, runWriteGate, sameStrList, type GateContext, type WriteCandidate } from "./gates.ts";
import { withStoreLock } from "./lock.ts";
import { pruneMemory } from "./prune.ts";
import { exportMemories, findStaleOpen, importMemories } from "./portable.ts";
import { listSnapshots, restoreSnapshot } from "./undo.ts";
import { SESSION_CAP, SessionLru } from "./sessions.ts";
import { evidenceFileFor, record, recordCaptureLag } from "./evidence.ts";
import { proposeConsolidations, renderProposals } from "./consolidate.ts";
import { readReads } from "./hits.ts";
import {
  compactionAnchor,
  contextualPull,
  formatMemory,
  pullQuery,
  sharedTerms,
} from "./inject.ts";
import { createInjectionEpochs } from "./injection-epochs.ts";
import { readLedger, neverRetrieved, recordHits, useSignals, type HitSource } from "./hits.ts";
import { formatInit, runInit } from "./init.ts";
import { ensureInitCommand, ensureMemoryReportCommand } from "./command.ts";
import {
  blockedRecent,
  renderMemoryReport,
  type Measured,
  captureLag,
  captureLagLines,
  rowsPerDay,
  type StoreCounts,
} from "./status.ts";
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
} from "./triggers.ts";
import { getCurrent, setCurrent } from "./state.ts";
import { resolveRepo, setRepoScope, rememberSessionDir, sessionDir, sessionDirFirm, bindSessionProvisional, writeTarget } from "./repokey.ts";
import { parseLine, readLines } from "./logfmt.ts";
import { buildCapturePrompt, flattenTranscript, lagSince, parseCandidates, parseModelRef } from "./capture.ts";
import { redactSecrets } from "./secrets.ts";
import { flattenMemoryText } from "./sanitize.ts";
import { bunFloorWarning } from "./runtime.ts";
import {
  captureSessionID,
  sessionDirectoryFromMessages,
  sessionDirectoryFromRow,
  sessionIdentityEvent,
  sessionUsageEvent,
  toolIdentity,
} from "./host.ts";

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
} from "./schema.ts";

function scoreMemory(m: Memory, q: string): number {
  // Same indexed fields as the injection scorer (#40): a row recalled by one of
  // its keywords is the same row recalled by the prose that keyword stands for.
  const kw = m.kw?.length ? ` ${m.kw.join(" ")}` : "";
  const hay = `${m.type} ${m.scope} ${m.content}${kw}`.toLowerCase();
  let score = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (hay.includes(w)) score++;
    if (m.scope.toLowerCase() === w) score += 2;
    if (m.type.toLowerCase() === w) score += 2;
  }
  return score;
}

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
    await ctx.tool?.transform((editor) => {
      const direct = { codemode: false } as const;

      editor.add(validated(RememberArgs, {
        name: "memory_remember",
        description:
          "Store a memory after the 4-gate write pipeline validates it (canonical graph, stale refs, dupes). Blocked writes record evidence instead of persisting. Add `kw` — 3-5 aliases, synonyms, verb forms or the literal command a FUTURE session would search with — to make a row findable when the wording differs; keywords are indexed, never injected.",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          const { sid } = toolIds(context);
          const candidate: WriteCandidate = {
            type: args.type,
            scope: args.scope,
            content: args.content,
            issue: args.issue,
            tags: args.tags,
            kw: args.kw,
            status: args.status,
            repo: args.global ? "global" : undefined,
          };
          await bindSessionIdentity(sid);
          // An explicit global write needs no repository owner; anything else
          // does (#152).
          if (!args.global) {
            const ownerless = ownerlessWriter(sid);
            if (ownerless) return await refuseOwnerlessWrite(ownerless, "remember");
          }
          const outcome = await runWriteGate(candidate, gateContext(sid));
          // A durable row whose audit line fell is NOT a clean success
          // (#155 review): the reply says what is missing where it is
          // missing, and the row itself stands.
          if (outcome.action === "promoted")
            return { content: `Remembered: ${args.type} in ${args.scope}${auditCaveat(outcome)}` };
          if (outcome.action === "collapsed") return { content: `Duplicate ignored: ${args.type}/${args.scope}` };
          return {
            content: `Write blocked at GATE (${outcome.reason}). ${
              outcome.hint ?? "Evidence recorded; inspect with memory_evidence."
            }`,
          };
        },
      }));

      editor.add(validated(ConsolidateArgs, {
        name: "memory_consolidate",
        description:
          "Propose consolidations of near-duplicate settled rows — read-only, nothing is written. Clusters same-scope same-type rows by jaccard, picks the most recently used member as canonical (#42's rule: the row retrieval keeps landing on), and proposes it ONLY when replaying the cluster's own logged reads proves the merged row catches at least as many reads as the best single member did. A cluster with no recorded reads is reported as unmeasured, never merged on resemblance. Resolve a proposal with memory_merge_review; absorbed rows stay recoverable. The merge is deterministic — the canonical row is the survivor's prose plus the absorbed rows' aliases — because this plugin ships no model and a rewritten row cannot be diffed or audited.",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          const { sid } = toolIds(context);
          const reader = readerFromSid(sid);
          const all = (await loadAll()).filter(isActive).filter((m) => isVisibleTo(m, reader));
          const rows = args.scope ? all.filter((m) => m.scope === args.scope) : all;
          const ledger = await readLedger();
          const use = ledger.byRow;
          const reads = await readReads();
          const report = proposeConsolidations(rows, use, reads, {
            ...(args.jaccard !== undefined ? { jaccard: args.jaccard } : {}),
          });
          const shown = report.plans.slice(0, args.limit ?? 10);
          const out = renderProposals({ ...report, plans: shown });
          await record(
            "consolidate_propose",
            { clusters: shown.length, rows: report.rowsBefore, would_drop: report.rowsBefore - report.rowsAfter },
            false,
          );
          return { content: out };
        },
      }));

      editor.add(validated(InitArgs, {
        name: "memory_init",
        description:
          "Initialize repository memory and knowledge graph. Ensures the codebase-memory graph for this repo is indexed (one-shot `cli` spawn; no session MCP needed) and re-derives build/lint/test/typecheck command memories through the write gate, then stores an init stamp keyed on git HEAD. Idempotent: a no-op when the stamp matches HEAD, unless force=true (refresh after a refactor).",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          const { sid } = toolIds(context);
          await bindSessionIdentity(sid);
          const ownerless = ownerlessWriter(sid);
          if (ownerless) return await refuseOwnerlessWrite(ownerless, "init");
          const summary = await runInit({
            liveRoot: gateContext(sid).liveRoot,
            force: args.force,
            mode: args.mode,
            sessionID: sid,
          });
          return { content: formatInit(summary) };
        },
      }));

      editor.add(validated(RecallArgs, {
        name: "memory_recall",
        description:
          "Look up durable project knowledge — build/test/lint commands, decisions, patterns, preferences, blockers — BEFORE searching the repo or reading files. Use for 'how do I run X', conventions, and past decisions. By scope, type, or free-text query; with no filters it returns the most recent memories.",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          const { sid, call } = toolIds(context);
          const reader = readerFromSid(sid);
          let results = (await loadAll()).filter(isActive).filter((m) => isVisibleTo(m, reader));
          if (!results.length) return { content: "No memories found" };
          const total = results.length;
          if (args.scope) results = results.filter((m) => m.scope.includes(args.scope!));
          if (args.type) results = results.filter((m) => m.type === args.type);
          if (args.query) {
            results = results
              .map((m) => ({ m, score: scoreMemory(m, args.query!) }))
              .filter((x) => x.score > 0)
              .sort((a, b) => b.score - a.score)
              .map((x) => x.m);
          }
          const limit = args.limit || 20;
          const limited = args.query ? results.slice(0, limit) : results.slice(-limit);
          if (!limited.length) return { content: "No matching memories" };
          const openIn = limited.filter((m) => m.status === "open").length;
          if (openIn > 0) {
            markFrontierTap(sid, call);
            await record(
              "frontier_tapped",
              {
                n_open: openIn,
                in_results: limited.length,
                turn: firstFrontierTap(sid)?.turn,
              },
              true,
              sid,
            );
          }
          if (args.query) await noteHits("recall", sid, limited, args.query);
          return { content: `Found ${results.length} (${total} total)\n\n${limited.map(formatMemory).join("\n")}` };
        },
      }));

      editor.add(validated(UpdateArgs, {
        name: "memory_update",
        description:
          "Update an existing memory (gated like remember; the prior entry is superseded, not erased). `query` selects which row to update: its exact id (ts), a clock fragment (e.g. HH:MM:SS.mmm), or a unique substring of its content. Omitting `query` targets the most recent active row of scope+type. An unmatched or ambiguous `query` fails closed and writes nothing. A prose edit carries over everything the call does not name — tags, issue, keywords, status, and the row's repository. Naming a row that was already updated to exactly this content (metadata included) reports the duplicate; if its live successor holds the prose and only the metadata you name differs, the successor is updated. A failure after the write is reported as PARTIAL: the replacement is durable and memory_undo merge/force restores the old row.",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          const { sid } = toolIds(context);
          await bindSessionIdentity(sid);
          const ownerless = ownerlessWriter(sid);
          if (ownerless) return await refuseOwnerlessWrite(ownerless, "update");
          const reader = readerFromSid(sid);
          // The whole update — resolve, gate, supersede — runs under one
          // UPDATE-ORDER lock. Without it, two concurrent updates that both
          // resolved the same still-active target both promoted and both
          // claimed success: markSuperseded is first-call-wins, so one
          // replacement row silently survived un-superseded (measured 5/5).
          // This outer lock is a DISTINCT file from anything runWriteGate or
          // markSuperseded take (sections run flat — never re-enter a file
          // you hold), and the acquisition order is always update-order
          // then store, never the reverse, so it cannot deadlock against a
          // plain writer. On timeout it FAILS closed: proceeding unlocked
          // is exactly the race this lock exists to close. The loser then
          // re-resolves under the lock, finds its target already retired,
          // and writes nothing — the documented fail-closed contract.
          // Flips once a replacement row is durable, so the catch below can
          // never claim "Nothing was written" about a write that happened
          // (#155's lie).
          let mutated = false;
          // The gate's durable steps: rows GATE-2 retired before a later
          // failure (round-3 probe 3). Non-empty means "Nothing was written"
          // is no longer writable.
          const gateDurable: string[] = [];
          try {
            return await withStoreLock(
              join(memoryRoot(), "update-order"),
              async () => {
                const prior = (await loadAll()).filter(
                  (m) => m.scope === args.scope && m.type === args.type && isActive(m) && isVisibleTo(m, reader),
                );
                // Resolve the row BEFORE the gate: an update that cannot identify its
                // target must write nothing, rather than silently superseding whichever
                // row happened to be newest in this scope+type.
                let resolved = resolveMemoryTarget(prior, args.query);
                if (resolved.status === "not_found") {
                  // Naming a SUPERSEDED row is not a miss (#155): the retry
                  // after a partial update lands here, and when that row's
                  // active successor already carries exactly this content the
                  // honest verdict is the duplicate one, not a dead end. Two
                  // subtleties the first cut missed: the successor's prose was
                  // stored REDACTED while a retry re-carries the raw input
                  // (the comparison must scrub), and "exactly this content"
                  // must mean the metadata too — a retry that also names new
                  // keywords still has work to do, and that work belongs on
                  // the chain head, so the update CONTINUES against the
                  // successor instead of collapsing here.
                  let chainHead: Memory | undefined;
                  if (args.query) {
                    const rows = (await loadAll()).filter(
                      (m) => m.scope === args.scope && m.type === args.type && isVisibleTo(m, reader),
                    );
                    const stale = resolveMemoryTarget(rows, args.query);
                    if (stale.status === "ok" && stale.target && !isActive(stale.target)) {
                      let latest = stale.target;
                      const walked = new Set<string>([latest.ts]);
                      while (latest.superseded_by) {
                        const next = rows.find((m) => m.ts === latest.superseded_by);
                        if (!next || walked.has(next.ts)) break;
                        walked.add(next.ts);
                        latest = next;
                      }
                      if (isActive(latest) && latest.content.trim() === redactSecrets(args.content).trim()) {
                        const restated =
                          (args.kw === undefined || sameStrList(args.kw, latest.kw)) &&
                          (args.status === undefined || args.status === (latest.status ?? "settled"));
                        if (restated) {
                          // Every other verdict is auditable; this one must
                          // be too — the message tells the model to consult
                          // memory_evidence.
                          await record(
                            "dedup_collapse",
                            { op: "update", named: stale.target.ts, match: latest.ts, action: "exact_successor", incoming_ignored: true },
                            true,
                            sid,
                          );
                          return {
                            content:
                              `Duplicate ignored: ${args.type}/${args.scope} — ${JSON.stringify(args.query)} was already ` +
                              `updated to exactly this content (${latest.ts}). Nothing was written.`,
                          };
                        }
                        chainHead = latest;
                      }
                    }
                  }
                  if (!chainHead) {
                    const where = args.query ? ` matches ${JSON.stringify(args.query)}` : "";
                    return {
                      content: `memory_update blocked: no active ${args.type} row in ${args.scope}${where}. Nothing was written.`,
                    };
                  }
                  resolved = { status: "ok", target: chainHead };
                }
                if (resolved.status === "ambiguous") {
                  return {
                    content:
                      `memory_update blocked: ${JSON.stringify(args.query)} matches ${resolved.candidates.length} active ` +
                      `${args.type} rows in ${args.scope} (${resolved.candidates.map((m) => m.ts).join(", ")}). ` +
                      "Pass a row id or a unique content substring. Nothing was written.",
                  };
                }
                const target = resolved.target;
                // A prose edit is not a metadata reset (#154): fields the
                // call does not name carry over from the row being
                // replaced, so updating an imported row can no longer
                // launder away its provenance or issue link. kw follows
                // the same rule with an override: omitted keeps the
                // target's, provided replaces. The carry completes to the
                // five fields of the #129 viewer precedent: STATUS (an
                // open frontier row stays open) and REPO (updating a
                // global row from one repository must not re-house it out
                // of every other repository's view — "an edit must never
                // widen visibility", and it must never narrow it either).
                // These are also the fields the collapse-completion judges
                // (review round 3): the fold asks whether the survivor
                // already carries the REQUESTED state — not the pre-edit
                // target's. An update naming kw:["new-alias"] is not
                // "already standing" on a row holding ["old-alias"].
                const requested = {
                  kw: args.kw ?? target.kw,
                  tags: target.tags,
                  issue: target.issue,
                  status: (args.status ?? target.status) ?? "settled",
                  repo: target.repo ?? "global",
                };
                const outcome = await runWriteGate(
                  {
                    type: args.type,
                    scope: args.scope,
                    content: args.content,
                    kw: requested.kw,
                    tags: requested.tags,
                    issue: requested.issue,
                    status: requested.status,
                    repo: requested.repo,
                    repoPath: target.repo ? target.repoPath : undefined,
                  },
                  { ...gateContext(sid), reader, supersedesTs: target.ts, durable: gateDurable },
                );
                if (outcome.action === "promoted" && outcome.ts && target) {
                  mutated = true;
                  const replacement = outcome.ts;
                  const retired = target.ts;
                  // The merge_review PARTIAL shape (156e887) applied to
                  // update: the replacement IS durable, so the message says
                  // exactly which follow-up step failed and what a retry does
                  // (#155 — never claim "Nothing was written" from here).
                  const partial = (why: string) => ({
                    content:
                      `memory_update PARTIAL: replacement ${replacement} IS on disk (memory_undo merge or force ` +
                      `restores ${retired}), but ${why}. Re-running this update reports the duplicate.`,
                  });
                  let retiredNow = false;
                  try {
                    retiredNow = await markSuperseded(retired, {
                      superseded_by: replacement,
                      reason: "update",
                      symbol: retired,
                      from: retired,
                      to: replacement,
                    });
                  } catch (err) {
                    return partial(
                      `retiring ${retired} failed: ${err instanceof Error && err.message ? err.message : String(err)}`,
                    );
                  }
                  if (!retiredNow) {
                    // merge_review checks exactly this boolean (156e887);
                    // "Updated (superseded X)" cannot be printed over a
                    // retirement a parallel supersession performed — that
                    // pointer names a DIFFERENT successor, and the confident
                    // line would hide a second active row.
                    return partial(
                      `${retired} had ALREADY been retired by another supersession while this call ran — ` +
                        `it points at that successor, not at ${replacement}; check memory_evidence`,
                    );
                  }
                  if (outcome.evidenceError !== undefined) {
                    return partial(`its write_promoted audit line was not recorded (${outcome.evidenceError})`);
                  }
                  return { content: `Updated ${args.type} in ${args.scope} (superseded ${retired})` };
                }
                if (outcome.action === "promoted")
                  return { content: `Remembered: ${args.type} in ${args.scope}${auditCaveat(outcome)}` };
                if (outcome.action === "collapsed") {
                  // Completion (#155 convergence): when a retry collapses
                  // because an ACTIVE row already holds exactly this content
                  // while the row it NAMES is still active (the supersede
                  // step of an earlier PARTIAL attempt never landed), the
                  // idempotent close is to retire the named row in the
                  // survivor's favor — a bare "Duplicate ignored" would leave
                  // two active rows forever and a retry that never converges.
                  // first-call-wins makes this safe to attempt on any path.
                  // But the fold must not INVERT #154 (review): retiring the
                  // named row is loss-free only when the survivor already
                  // carries what the named row carries — the SAME predicate
                  // GATE-3 uses to call same-prose-different-metadata an
                  // edit rather than a duplicate. Otherwise the survivor
                  // would stand stripped of the named row's issue link,
                  // keywords, tags or OPEN frontier standing, and a "clean
                  // no-op" message would paper over a metadata destruction.
                  // On disagreement nothing retires: both ids are named and
                  // a human (or an update on the survivor) decides.
                  const survivorTs = outcome.collapsedWith;
                  if (target && survivorTs && survivorTs !== target.ts) {
                    // #175: the gate can observe a session move after this call captured
                    // its reader. Recheck before trusting or describing the survivor.
                    const survivor = (await loadAll()).find(
                      (m) => m.ts === survivorTs && !m.superseded_by && isVisibleTo(m, reader),
                    );
                    if (survivor) {
                      // #175: private rows are visible by key OR path. Equal keys alone
                      // can drop another checkout's access after an origin change.
                      // For global rows, isVisibleTo ignores paths.
                      // Match raw paths like isVisibleTo; filesystem aliases need not
                      // grant the same readers access. This restricts automatic folds;
                      // explicit merge_review authorizes both seats under #131 instead.
                      const samePathVisibility = requested.repo === "global" ||
                        (target.repoPath ?? "") === (survivor.repoPath ?? "");
                      // The predicate is the REQUESTED state vs the survivor
                      // (round 3): content equality is already proven by the
                      // collapse, so the fold is loss-free only when the
                      // survivor also carries the metadata THIS call asked
                      // for — and stands where the target stands for readers
                      // of other repositories (repo visibility: folding a
                      // global row into a repo-private survivor would
                      // narrow a visibility the promotion path exists to
                      // preserve, and the reverse would leak).
                      if (
                        sameStrList(requested.kw, survivor.kw) &&
                        sameStrList(requested.tags, survivor.tags) &&
                        requested.issue === survivor.issue &&
                        requested.status === (survivor.status ?? "settled") &&
                        requested.repo === (survivor.repo ?? "global") &&
                        samePathVisibility
                      ) {
                        const done = await markSuperseded(target.ts, {
                          superseded_by: survivorTs,
                          reason: "update",
                          symbol: target.ts,
                          from: target.ts,
                          to: survivorTs,
                        }, gateDurable);
                        if (done) {
                          return {
                            content:
                              `Duplicate: ${args.type}/${args.scope} already stands active as ${survivorTs}; ` +
                              `${target.ts} was retired in its favor. Nothing new was written.`,
                          };
                        }
                      } else {
                        const differs: string[] = [];
                        if (requested.status !== (survivor.status ?? "settled"))
                          differs.push(`status ${requested.status} vs ${survivor.status ?? "settled"}`);
                        if (requested.issue !== survivor.issue)
                          differs.push(`issue ${requested.issue ?? "-"} vs ${survivor.issue ?? "-"}`);
                        if (!sameStrList(requested.kw, survivor.kw))
                          differs.push(`kw [${(requested.kw ?? []).join(", ") || "-"}] vs [${(survivor.kw ?? []).join(", ") || "-"}]`);
                        if (!sameStrList(requested.tags, survivor.tags))
                          differs.push(`tags [${(requested.tags ?? []).join(", ") || "-"}] vs [${(survivor.tags ?? []).join(", ") || "-"}]`);
                        if (requested.repo !== (survivor.repo ?? "global"))
                          differs.push(`visibility ${requested.repo} vs ${survivor.repo ?? "global"}`);
                        if (!samePathVisibility) differs.push("repository path visibility differs");
                        return {
                          content:
                            `Duplicate: ${args.type}/${args.scope} stands active as ${survivorTs}, but ${target.ts} ` +
                            `was NOT retired — the survivor does not carry what this update asked for ` +
                            `(${differs.join("; ")}), and the fold would drop it. Both stay active. To deliberately ` +
                            `keep only the survivor, use memory_merge_review with loser="${target.ts}", ` +
                            `survivor="${survivorTs}", and an explicit reason. This keeps the survivor's metadata and visibility.`,
                        };
                      }
                    }
                  }
                  return { content: `Duplicate ignored: ${args.type}/${args.scope}` };
                }
                return { content: `Write blocked at GATE (${outcome.reason}). ${outcome.hint ?? ""}`.trimEnd() };
              },
              {
                onTimeout: "fail",
                onEvent: (event, waitedMs) => {
                  void record("store_lock", { event, waited_ms: waitedMs, op: "update" });
                },
              },
            );
          } catch (err) {
            // Everything that still throws here was PRE-WRITE for THIS call's
            // replacement: the fail-closed lock timeout, the #152 choke-point
            // refusal, an evidence fault BEFORE the append. Post-append audit
            // failures no longer reach this catch — the gate reports them on
            // the promoted outcome (#155). mutated is the belt-and-braces
            // truth check: a future post-write throw must report a partial,
            // never a clean nothing. And gateDurable closes the last gap
            // (round 3): the gate may have RETIRED OTHER rows at GATE-2
            // before the fault that got here — those tombstones are on disk,
            // and naming them beats the "Nothing was written" premise.
            const msg = err instanceof Error && err.message ? err.message : String(err);
            return {
              content: mutated
                ? `memory_update PARTIAL: a step after the durable write failed: ${msg}. ` +
                  "Re-running this update reports the duplicate; inspect with memory_evidence."
                : gateDurable.length > 0
                  ? `memory_update PARTIAL: ${msg} No replacement was written, but this call had ALREADY retired ` +
                    `${gateDurable.length} row(s) (${gateDurable.join(", ")}): those retirements ARE on ` +
                    "disk and their audit lines may not all have landed. Re-running this update will not undo " +
                    "them — reconcile with memory_evidence / memory_undo before retrying."
                  : `memory_update blocked: ${msg} Nothing was written.`,
            };
          }
        },
      }));

      editor.add(validated(ForgetArgs, {
        name: "memory_forget",
        description:
          "Delete memories by scope and type. Snapshots first, logs the reason for audit, never touches a repo.",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          const { sid } = toolIds(context);
          const res = await pruneMemory(args.scope, args.type, args.reason, sid);
          if (res.error) return { content: `memory_forget PARTIAL: deleted row(s) ${res.deleted.map((d) => d.memory.ts).join(", ")}; stopped: ${res.error}. Rejection tombstones or audit lines may be incomplete. Inspect memory_evidence / memory_undo before retrying.` };
          if (!res.deleted.length) return { content: `No memories found for ${args.type} in ${args.scope}` };
          return { content: `Deleted ${res.deleted.length} ${args.type} memory(s) from ${args.scope}. Audit: ${res.audit}` };
        },
      }));

      editor.add(validated(EmptyArgs, {
        name: "memory_list",
        description: "List memory scopes and types for discovery.",
        options: direct,
        async execute(_args, context): Promise<{ content: string }> {
          const { sid } = toolIds(context);
          const reader = readerFromSid(sid);
          const mems = (await loadAll()).filter(isActive).filter((m) => isVisibleTo(m, reader));
          if (!mems.length) return { content: "No memories found" };
          const scopes = new Map<string, number>();
          const types = new Map<string, number>();
          for (const m of mems) {
            scopes.set(m.scope, (scopes.get(m.scope) ?? 0) + 1);
            types.set(m.type, (types.get(m.type) ?? 0) + 1);
          }
          const fmt = (map: Map<string, number>) =>
            [...map.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([k, c]) => `  ${flattenMemoryText(k)}: ${c}`)
              .join("\n");
          return { content: `Total: ${mems.length}\n\nScopes:\n${fmt(scopes)}\n\nTypes:\n${fmt(types)}` };
        },
      }));

      editor.add(validated(UndoArgs, {
        name: "memory_undo",
        description:
          "List memory snapshots, or restore one (rollback). Only snapshots inside this store's snapshots directory are accepted: pass a bare name from the list or its full path. Non-standard files in snapshots/ are not listed or restorable. SAFE BY DEFAULT: restore refuses if the current file has rows added or edited since the snapshot, and audited human/tool deletions stay deleted. Re-run with merge=true to restore AND keep divergent rows, or force=true for an explicit exact rollback. Blocklisted rows remain inactive in every mode. Rows belonging to other repositories are never restored, rewound, or dropped in any mode — their lines survive verbatim, though a restore may place them later in the shared file. Global rows are visible to every repository, so they are in every repository's rollback scope.",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          if (args.snapshot) {
            const mode = args.force ? "force" : args.merge ? "merge" : "check";
            // Day files are shared across repositories (#153): the rollback
            // carries the CALLER's reader, so rows another repo owns survive
            // untouched in every mode instead of riding the snapshot wholesale.
            const { sid } = toolIds(context);
            const res = await restoreSnapshot(args.snapshot, memoryRoot(), mode, readerFromSid(sid));
            if (!res.restored) {
              const parts = [...res.concurrentAdded, ...res.concurrentChanged];
              return {
                content:
                  `Undo refused: ${res.concurrentAdded.length} row(s) added and ` +
                  `${res.concurrentChanged.length} changed since this snapshot — the shared file ` +
                  `moved after it. Divergent rows (ts): ${parts.join(", ")}. ` +
                  `If those belong to another session, re-run with merge=true (restore the file ` +
                  `AND keep them); if they are the writes you are undoing, use force=true. ` +
                  (res.foreignPreserved
                    ? `${res.foreignPreserved} row(s) in this file belong to other repositories; they survive in every mode.`
                    : "Rows belonging to other repositories survive in every mode."),
              };
            }
            const kept = res.mode === "merge" && (res.concurrentAdded.length || res.concurrentChanged.length)
              ? ` Kept ${res.concurrentAdded.length} added / ${res.concurrentChanged.length} changed row(s) written after the snapshot.`
              : "";
            const safety = res.safety ? ` Pre-restore file snapshotted -> ${res.safety}.` : "";
            const omitted = res.deletedOmitted.length
              ? ` Omitted ${res.deletedOmitted.length} deliberately deleted row(s); use force=true to recover them.`
              : "";
            const foreign = res.foreignPreserved
              ? ` Left ${res.foreignPreserved} row(s) belonging to other repositories untouched.`
              : "";
            return { content: `Restored ${basename(res.target)} from ${res.mode} snapshot -> ${res.target}.${kept}${safety}${omitted}${foreign}` };
          }
          const snaps = await listSnapshots();
          if (!snaps.length) return { content: "No snapshots" };
          return { content: snaps.map((s) => `${s.name}  (${s.bytes} bytes)`).join("\n") };
        },
      }));

      editor.add(validated(EvidenceArgs, {
        name: "memory_evidence",
        description: "Read captured evidence (data only) for a date, optionally filtered by event.",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          const { sid } = toolIds(context);
          const reader = readerFromSid(sid);
          // #130: the ONE path the schema-validated date can resolve to —
          // a real calendar day inside the evidence dir, never a traversal
          // into the raw store or the filesystem beyond it.
          const file = evidenceFileFor(args.date);
          if (!file) {
            return {
              content:
                "memory_evidence blocked: date must be a real YYYY-MM-DD calendar date — nothing was read.",
            };
          }
          let lines = await readLines(file);
          // Data partitions too (#131's ownership rule, applied to evidence):
          // a line stamped to another repository is not this session's data,
          // and a line a NAMED session wrote while unresolved is private to
          // that session — the caller's sid is what the private branch
          // matches against (#128 re-review).
          if (reader.kind !== "admin") {
            lines = lines.filter((l) => {
              const fields = parseLine(l);
              return !fields || evidenceVisibleTo(fields, reader, sid);
            });
          }
          if (args.ev) lines = lines.filter((l) => l.includes(`ev=${args.ev}`));
          if (!lines.length) return { content: "No evidence" };
          const limit = args.limit || 50;
          return { content: lines.slice(-limit).join("\n") };
        },
      }));

      editor.add(validated(MergeReviewArgs, {
        name: "memory_merge_review",
        description:
          "Resolve an open merge/review gate non-destructively: mark the loser as superseded_by the survivor, and clear any supersession the survivor itself carries so the canonical row stays recallable. Both rows stay active data (the loser is recoverable via memory_undo); nothing is deleted. A session may merge exactly the rows it may read: global rows are mergeable from anywhere, but a row belonging to another repository is refused in either seat. Refuses before writing when the reason or the survivor id is missing, the survivor id names no row in the store, the loser is already superseded or is the survivor itself, or either seat names a foreign repository's row. Later lock or I/O failures can leave partial changes; the reply names the completed retirement and failure.",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          const { sid } = toolIds(context);
          if (!args.loser || !args.survivor || !args.reason) {
            return { content: "merge_review blocked: loser, survivor, and reason are all required (fail-closed)." };
          }
          if (args.loser === args.survivor) {
            // (Same-row input would mark and then revive the same row: a
            // silent no-op that reports full success.)
            return { content: "merge_review blocked: loser and survivor are the same row — nothing to resolve. No evidence written." };
          }
          // A row id is a pointer, not authority (#131): resolving and
          // authorizing BOTH seats happens against the caller's Reader —
          // captured at entry, never re-read after an await (#127) — and the
          // whole resolve/check/mutate runs under the same update-order lock
          // memory_update serializes on (#125), so the authorization is
          // revalidated under the mutation lock instead of against a snapshot
          // a concurrent update could have replaced. Acquisition order is
          // always update-order then store-file locks, never the reverse, so
          // this cannot deadlock against a plain writer; on timeout it fails
          // closed with nothing written.
          const reader = readerFromSid(sid);
          // A batch may publish the loser then refuse a later file. The sink
          // records that publish before the overall promise settles (#197).
          const mergeDurable: string[] = [];
          try {
            return await withStoreLock(
              join(memoryRoot(), "update-order"),
              async () => {
                const all = await loadAll();
                const survivorRow = all.find((m) => m.ts === args.survivor);
                // Probed: marking with a survivor id that names no row retired
                // the loser toward a pointer to nothing (the scope ended with
                // zero active rows) while the response declared it canonical.
                // Validate BEFORE touching the loser — a resolution must never
                // retire real data for a phantom.
                if (!survivorRow) {
                  return { content: `merge_review blocked: survivor ${args.survivor} does not exist in the store — nothing to resolve. No evidence written.` };
                }
                const loserRow = all.find((m) => m.ts === args.loser);
                // Visibility is the authorization contract (#131): a session
                // may merge exactly the rows it may read. Global and legacy
                // unstamped rows are visible everywhere and therefore
                // mergeable from anywhere — stated here, not granted
                // implicitly by store-wide reach. A foreign row in EITHER
                // seat — including an attempt to revive another repository's
                // superseded survivor — is refused before any mutation.
                if (loserRow && !isVisibleTo(loserRow, reader)) {
                  return { content: "merge_review blocked: the loser belongs to another repository — this session may not retire it. Nothing was done. No evidence written." };
                }
                if (!isVisibleTo(survivorRow, reader)) {
                  return { content: "merge_review blocked: the survivor belongs to another repository — this session may not promote or revive it. Nothing was done. No evidence written." };
                }
                const ok = await markSuperseded(args.loser, {
                  superseded_by: args.survivor,
                  reason: args.reason,
                  symbol: args.loser,
                  from: args.loser,
                  to: args.survivor,
                }, mergeDurable);
                if (!ok) {
                  return { content: "merge_review: loser not found or already superseded — nothing to resolve. No evidence written." };
                }
                // The survivor may itself have been superseded earlier (e.g. by
                // a row this very call just made the loser). Declaring it
                // canonical has to make it recallable, so clear its own marker.
                const revived = await clearSuperseded(args.survivor);
                // The response has always claimed "Evidence recorded" — now it
                // is true, and it names the session the merge ran FOR (#121's
                // residue on this line). The host tool_result hook covers
                // grep/read/edit/shell only, so a merge used to leave zero
                // trace: which reviewer decision, on which reason, reviving
                // what — unauditable.
                await record(
                  "merge_resolved",
                  {
                    loser: args.loser,
                    survivor: args.survivor,
                    revived,
                    reason: args.reason,
                  },
                  true,
                  sid,
                );
                return {
                  content:
                    `Resolved merge: ${args.survivor} is canonical; ${args.loser} superseded (recoverable via memory_undo). ` +
                    (revived ? `Survivor's own supersession cleared, it is active again. ` : "") +
                    `Evidence recorded for reason='${args.reason}'.`,
                };
              },
              {
                onTimeout: "fail",
                onEvent: (event, waitedMs) => {
                  void record("store_lock", { event, waited_ms: waitedMs, op: "merge" });
                },
              },
            );
          } catch (err) {
            // Before mutation this is the fail-closed lock contract: nothing
            // written. Once a file published, the loser IS retired —
            // the honest report names the completed mutation and the failed
            // follow-up (evidence/revive), not a blanket "nothing was done".
            const why = err instanceof Error ? err.message : String(err);
            if (mergeDurable.length === 0) {
              return {
                content: `merge_review blocked: ${why} — nothing was done. Retry.`,
              };
            }
            return {
              content:
                `merge_review PARTIAL: ${args.loser} IS retired on disk (superseded_by ${args.survivor}; ` +
                `recoverable via memory_undo) but the remaining operation failed: ${why}. ` +
                `The evidence line may be missing; re-running reports the loser already superseded.`,
            };
          }
        },
      }));

      editor.add(validated(ExportArgs, {
        name: "memory_export",
        description:
          "Export active memories as a JSONL file for backup or transfer to another machine — scoped to what this session can read: its own repository plus global rows (full-store breadth belongs to a session-less call made outside the plugin, the library route; the viewer has no export route). The first line is a metadata header ({_export,version,exportedAt,count}); each later line is one JSON object {ts,type,scope,content,status,tags,issue}. The header is what lets memory_import keep repo-scoped status:\"open\" frontier rows — a hand-written file without it imports such rows as settled, as does an imported open row claiming repo:\"global\". Defaults to a unique <memory-root>/exports/<timestamp>-<unique>.jsonl (each default export gets its own file; two exports in the same second never share a path); `file` must name a path inside <memory-root>/exports (a relative path resolves against it), `scope` exports one scope. Superseded rows are not exported (history stays in the store).",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          try {
            const { sid } = toolIds(context);
            const res = await exportMemories({ scope: args.scope, file: args.file, sessionID: sid });
            return { content: `Exported ${res.count} memories -> ${res.path}` };
          } catch (err) {
            return {
              content: `memory_export failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      }));

      editor.add(validated(ImportArgs, {
        name: "memory_import",
        description:
          "Import memories from a JSONL export (see memory_export). Every row goes through the same 4-gate write pipeline as memory_remember (tagged `import`, original tags preserved), so duplicates collapse and ungrounded rows are blocked exactly as usual — those are normal tallied outcomes, not errors. Malformed lines are skipped and counted. `file` must be inside the memory root — copy the export there first. Frontier policy: status:\"open\" exempts a row from ref grounding, so it requires a memory_export header and cannot claim global scope; imported repo stamps are kept only when they match the importing session's repo, otherwise the importing repo is stamped. A stamped open row is downgraded when there is no current repo scope to verify it. Imported content is unverified by construction: injected rows surface a `[via import]` provenance marker.",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          const { sid } = toolIds(context);
          // Resolve before touching the file: every imported row is re-stamped
          // with the IMPORTING session's repository, so an unresolved caller
          // would move a whole export into whoever set up last (#152).
          await bindSessionIdentity(sid);
          const ownerless = ownerlessWriter(sid);
          if (ownerless) return await refuseOwnerlessWrite(ownerless, "import");
          const importGate = gateContext(sid);
          try {
            const t = await importMemories(
              args.file,
              (c) =>
                runWriteGate(
                  { ...c, tags: [...new Set([...(c.tags ?? []), "import"])] },
                  importGate,
                ),
              sid,
            );
            return {
              content:
                `Imported ${args.file}: ${t.promoted} promoted, ${t.collapsed} duplicates collapsed, ` +
                `${t.blocked} blocked by the gate, ${t.skipped} malformed lines skipped.` +
                (t.downgraded
                  ? ` ${t.downgraded} open rows downgraded to settled (missing eligible memory_export header or verifiable repo scope).`
                  : "") +
                // Rows that landed without their write_promoted line are
                // durable but invisible to memory_evidence (#155 review) —
                // the tally owes the reader the count, not silence.
                (t.unaudited
                  ? ` ${t.unaudited} promoted rows landed without their write_promoted audit line (${t.auditError}); memory_evidence will miss them.`
                  : ""),
            };
          } catch (err) {
            return {
              content: `memory_import failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      }));

      editor.add(validated(DecayArgs, {
        name: "memory_decay",
        description:
          "Retire stale open threads (status=open older than olderThanDays) by superseding them — never deleting; rows stay recoverable via memory_undo. DRY RUN BY DEFAULT: without an explicit dryRun=false this only LISTS what would retire and mutates nothing (fail-closed). A real run snapshots every affected file before the first mutation.",
        options: direct,
        async execute(args, context): Promise<{ content: string }> {
          const { sid } = toolIds(context);
          const days = Number(args.olderThanDays) > 0 ? Number(args.olderThanDays) : 14;
          const dryRun = args.dryRun !== false; // only an explicit false mutates
          const stale = await findStaleOpen(days, sid);
          if (!stale.length) {
            return { content: `No active open threads older than ${days} days.` };
          }
          const listing = stale
            .map(
              (m) =>
                `  ${flattenMemoryText(m.ts)} ${flattenMemoryText(m.type)}/${flattenMemoryText(m.scope)}: ${flattenMemoryText(m.content).slice(0, 100)}`,
            )
            .join("\n");
          if (dryRun) {
            await record(
              "decay_dry_run",
              { days, stale: stale.length, mem: stale.map((m) => m.ts).join(",") },
              false,
            );
            return {
              content:
                `Dry run: ${stale.length} open thread(s) older than ${days} days:\n${listing}\n` +
                "Re-run with dryRun=false to supersede them (snapshot first; recoverable via memory_undo).",
            };
          }
          // Snapshot-before-mutate: the SAME helper prune() uses in memory.ts,
          // one whole-file copy per affected file, taken before the first
          // mutation. The batch pass snapshots again per file it touches; this
          // pass guarantees a pre-decay copy exists even if a later file fails.
          const snapshot = await snapshotFiles([...new Set(stale.map((m) => m.file))]);
          // One lock/read/snapshot/publish per file for the whole decay run (#61):
          // N retired rows are one undo point, not N. Idempotent (a no-op on rows
          // already superseded, out-of-band ones skipped under the lock).
          const durable: string[] = [];
          let retired: number;
          try {
            retired = await markManySuperseded(
              stale.map((m) => ({ ts: m.ts, fields: { superseded_by: "decay", reason: "decay" } })), durable,
            );
          } catch (err) {
            if (durable.length === 0) throw err;
            let why = err instanceof Error ? err.message : String(err);
            await record("decay_applied", { days, retired: durable.length, mem: durable.join(","), snapshot: snapshot.join(","), partial: true, error: why }, false).catch((audit) => { why += `; audit failed: ${String(audit)}`; });
            return { content: `memory_decay PARTIAL: retired row(s) ${durable.join(", ")}; stopped: ${why}. Recover with memory_undo; inspect memory_evidence before retrying.` };
          }
          await record(
            "decay_applied",
            {
              days,
              retired,
              mem: durable.join(",") || "-",
              snapshot: snapshot.join(",") || "-",
            },
            false,
          );
          return {
            content:
              `Decayed ${retired} open thread(s) older than ${days} days ` +
              `(superseded, not deleted; snapshot: ${snapshot[0] ?? "-"}). ` +
              "Recover with memory_undo.",
          };
        },
      }));

      editor.add(validated(EmptyArgs, {
        name: "memory_status",
        description:
          "Plain-text memory report for chat clients (desktop/web/IDE), same sections as the terminal /memory panel: CONTEXT (this session's injected block, budget use, cumulative ride and abstentions), CACHE (plain-language cache receipts: bust count, and the provider-reported share of prompt tokens served from cache — the proof that memory never mutates your prefix), the block verbatim, recent blocked writes with gate reasons, and store stats. Reads only — no model call.",
        options: direct,
        async execute(_args, context): Promise<{ content: string }> {
          // In-process truth: the live epoch + ledger, fresher than any file.
          const sid = toolIds(context).sid;
          const status = sid === "?" ? null : await sessions.buildPayload(sid);
          const all = await loadAll();
          const act = all.filter(isActive);
          const store: StoreCounts = {
            active: act.length,
            superseded: all.length - act.length,
            open: act.filter((m) => m.status === "open").length,
            scopes: new Set(act.map((m) => m.scope)).size,
            malformed: malformedCount(),
          };
          // Use ledger (#42): how much of the store has never been surfaced.
          // Reported, never acted on — retirement is a decision, not a metric.
          const ledger = await readLedger();
          store.neverRetrieved = neverRetrieved(act, ledger).length;
          store.ledgerSince = ledger.since;
          // Self-metrics (#44): what the store costs, how fast it grows, and how
          // stale a capture is when it fires. Same rule as above — the numbers
          // are the point, not a verdict on them.
          store.bytes = act.reduce((n, m) => n + new TextEncoder().encode(formatMemory(m)).length, 0);
          store.bytesPerRow = act.length ? Math.round(store.bytes / act.length) : 0;
          store.rowsPerDay = rowsPerDay(act) ?? undefined;
          store.captureLag = captureLag(await captureLagLines());
          return {
            content: renderMemoryReport({ status, store, blocked: await blockedRecent(6) }),
          };
        },
      }));
    });

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
          // #152: an instance with no workspace cannot say which repository the
          // mined rows belong to, and rows with no owner are exactly what the
          // store refuses. Skip BEFORE the model call — no tokens spent on a
          // capture that cannot be stored — and leave the reason in evidence.
          if (!writeTarget(sid).ok) {
            await record("auto_capture_refused", { session: sid, trigger }, true, sid);
            return;
          }
          const captureGate = gateContext(sid);
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
                {
                  ...c,
                  tags:
                    trigger === "compaction"
                      ? ["auto-capture", CAPTURE_COMPACT_TAG]
                      : ["auto-capture"],
                },
                { ...captureGate, durable },
              );
            } catch (err) {
              // A refused write must not disappear into the hook's fail-soft
              // wrapper. Preserve any earlier gate retirements in the receipt.
              await record(durable.length ? "auto_capture_partial" : "auto_capture_refused", {
                session: sid, trigger, type: c.type, scope: redactSecrets(c.scope),
                reason: String(err), retired: durable.join(",") || undefined,
              }, false, sid);
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
            );
          }
          await recordCaptureLag(sid, lagMs, candidates.length ? "candidates" : "empty");
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
