// opencode-self-improvement: one opencode plugin bundling durable memory, the
// 4-gate write pipeline, deterministic reflection triggers T1/T2/T4,
// tiny-digest injection with deterministic memory-first context and
// contextual pull, and snapshot/rollback.
//
// Registers tools via `ctx.tool.transform` (JSON Schema) and hooks via the
// OpenCode V2 session/tool API. Slash commands are installed as markdown by
// src/command.ts. The default export `{ id, setup(ctx) }` is checked against
// the SDK's Plugin type using a type-only import (see the note on `plugin`).
import { registerHooks } from "./events.ts";
import { guarded, setGuardedFailureReporter } from "./core/hooks.ts";
import type { PluginCtx } from "./core/host.ts";
import type { Cleanup, Plugin } from "@opencode/plugin/promise/plugin";
import { basename, join } from "node:path";
import { frontierBudget, injectBudget } from "./core/config/budgets.ts";
import { memoryRoot } from "./core/config/paths.ts";
import { loadAll, malformedCount } from "./store/files/load.ts";
import { snapshotFiles } from "./store/files/snapshots.ts";
import {
  clearSuperseded,
  markManySuperseded,
  markSuperseded,
} from "./store/files/supersede.ts";
import { resolveMemoryTarget } from "./store/files/target.ts";
import { type Memory } from "./store/model/memory.ts";
import { isActive, isInjectable } from "./store/model/predicates.ts";
import { evidenceVisibleTo, isVisibleTo } from "./store/model/visibility.ts";
import { auditCaveat, sameStrList, type WriteCandidate } from "./gate/gate.ts";
import { withStoreLock } from "./store/lock.ts";
import {
  isQuarantined,
  quarantineReasons,
} from "./store/quarantine/quarantine.ts";
import { pruneMemory } from "./store/prune.ts";
import { findStaleOpen } from "./portable/decay.ts";
import { exportMemories } from "./portable/export.ts";
import { importMemories } from "./portable/import.ts";
import { listSnapshots, restoreSnapshot } from "./store/undo.ts";
import { evidenceFileFor, record } from "./evidence/record.ts";
import { proposeConsolidations } from "./consolidate/propose.ts";
import { renderProposals } from "./consolidate/render.ts";
import { readReads } from "./hits/ledger.ts";
import { formatMemory } from "./inject/format.ts";
import { sharedTerms } from "./recall/shared-terms.ts";
import {
  configureAutoCapture,
  CAPTURE_EVENT_TYPES,
} from "./capture/runtime.ts";
export {
  resetCaptureCooldowns,
  TURN_END_EVENTS,
  CAPTURE_EVENT_TYPES,
  captureTriggerFor,
} from "./capture/runtime.ts";
export { resetSessionModels } from "./capture/session-model.ts";
import { createInjectionEpochs } from "./inject/epochs.ts";
import { createSessionContext } from "./identity/session-context.ts";
import { registerMemoryTools } from "./tools/registry.ts";
import {
  readLedger,
  neverRetrieved,
  recordHits,
  type HitSource,
} from "./hits/ledger.ts";
import { formatInit } from "./init/format.ts";
import { runInit } from "./init/run.ts";
import {
  ensureInitCommand,
  ensureMemoryReportCommand,
} from "./command/ensure.ts";
import { captureLag, captureLagLines, rowsPerDay } from "./status/metrics.ts";
import { type Measured, type StoreCounts } from "./status/payload.ts";
import { renderMemoryReport } from "./status/report.ts";
import { blockedRecent } from "./status/write.ts";
import { firstFrontierTap, markFrontierTap } from "./capture/triggers.ts";
import { peekTurns, setCurrent } from "./core/state.ts";
import {
  resolveRepo,
  setRepoScope,
  rememberSessionDir,
  bindSessionProvisional,
  writeTarget,
} from "./identity/repokey.ts";
import { parseLine } from "./core/logfmt/format.ts";
import { readLines } from "./core/logfmt/read.ts";
import { parseModelRef } from "./capture/candidates.ts";
import { flattenMemoryText } from "./store/sanitize.ts";
import { bunFloorWarning } from "./core/runtime.ts";

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

const PLUGIN_ID = "opencode-self-improvement";

// The setup-time Bun-floor warning fires once per process (setup can run for
// more than one location).
let bunFloorChecked = false;

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
    // #138: mirror every swallowed guarded() failure into the evidence file.
    // Hook name + error class ONLY — never the message, which can carry
    // conversation content. Fire-and-forget: evidence must not add a failure
    // to a path that already failed softly.
    setGuardedFailureReporter((name, err) =>
      record(
        "hook_error",
        {
          hook: name,
          error:
            err instanceof Error
              ? err.constructor?.name || "Error"
              : typeof err,
        },
        false,
      ).catch(() => {}),
    );
    setRepoScope(setupRoot ? resolveRepo(setupRoot) : null);
    // THIS instance's own workspace. The module scope says who loaded last;
    // this says who I am. An unbound session that calls into THIS instance
    // resolves here — never to another instance's scope (#127, multi-setup).
    const instanceDir =
      typeof setupRoot === "string" && setupRoot ? setupRoot : undefined;

    // Character budgets: relevance injection and contextual pulls share the
    // existing cap; the session-start frontier has its own larger cap. Plugin
    // options win over env fallbacks, and the frontier defaults to 3x the
    // effective injection budget.
    const budget = Number(ctx.options?.injectBudget) || injectBudget();
    const openBudget =
      Number(ctx.options?.frontierBudget) || frontierBudget(budget);

    // Warn-once Bun floor check (same setup-time warning style as the
    // captureModel warnings below): opencode embeds Bun, and the store code's
    // fs failure modes are Bun-version dependent, so flag an old host.
    if (!bunFloorChecked) {
      bunFloorChecked = true;
      const floorWarning = bunFloorWarning(
        typeof Bun === "undefined" ? undefined : Bun.version,
      );
      if (floorWarning) console.warn(floorWarning);
    }

    // Mirror the /repo-init slash command into opencode's global commands dir
    // (idempotent, write-if-missing). OpenCode 2.x loads `*.md` from
    // ~/.config/opencode/commands, so this is the canonical V2 install path.
    await ensureInitCommand();
    await ensureMemoryReportCommand();

    const {
      gateContext,
      ownerlessWriter,
      refuseOwnerlessWrite,
      toolIds,
      bindSessionFromApi,
      bindSessionIdentity,
    } = createSessionContext(ctx, { instanceDir, liveRoot });

    // ---- tools --------------------------------------------------------------
    // Use ledger (#42). `query` is what retrieval was asked with; what gets
    // stored is the vocabulary the answer SHARES with the query, taken from the
    // memory side, so the ledger can never become a copy of user prompts.
    // Fail-soft inside recordHits: telemetry must not break a read path.
    const noteHits = async (
      src: HitSource,
      sid: string,
      rows: Memory[],
      query: string,
    ): Promise<void> => {
      if (!rows.length || !query.trim()) return;
      const terms: string[] = [];
      for (const m of rows)
        for (const t of sharedTerms(query, m))
          if (!terms.includes(t)) terms.push(t);
      // #332: the turn is what joins a ride to the outcome of that same turn.
      // Read, never created-for: markTurn has already run for any session that
      // can reach a read path, so this does not seed state.
      await recordHits(src, sid, rows, terms, Date.now(), peekTurns(sid));
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
    let onCompactCapture:
      | ((sid: string, messages: unknown) => void)
      | undefined;

    const measuredController = await registerHooks(ctx, {
      guarded,
      sessions,
      instanceDir,
      budget,
      noteHits,
      bindSessionIdentity,
      bindSessionFromApi,
      measuredTurns,
      flushStatus,
      getCompactCapture: () => onCompactCapture,
    });
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
    // so decay/status — and bench/runners/capture-trigger-compare.ts — can measure
    // which trigger earns its tokens. Every failure is swallowed: capture must
    // never be able to break a session.
    const capture = configureAutoCapture(ctx, {
      instanceDir,
      gateContext,
      guarded,
    });
    onCompactCapture = capture.onCompactCapture;
    const captureCleanup = capture.cleanup;
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
        const pkg = await Bun.file(
          new URL("../package.json", import.meta.url),
        ).json();
        if (typeof pkg?.version === "string") pluginVersion = pkg.version;
      } catch {
        // a heartbeat with an unknown version still beats no heartbeat
      }
      const wantCapture = ctx.options?.autoCapture === true;
      // #139: an omitted captureModel is a valid arm — the capture inherits
      // the session's model (session.context) or the host default. Only an
      // explicit but malformed string is invalid_model.
      const captureModelOpt = ctx.options?.captureModel;
      const modelOk =
        captureModelOpt === undefined || !!parseModelRef(captureModelOpt);
      const capabilities = [
        "event.subscribe",
        "generate.text",
        "session.context",
      ].filter((name) => {
        const [domain, method] = name.split(".");
        return (
          typeof (ctx as unknown as Record<string, any>)?.[domain]?.[method] ===
          "function"
        );
      });
      const captureState = !wantCapture
        ? // captureOnCompact alone is a distinct misconfiguration (the
          // runtime warns about it and stays disabled) — name it, or "off
          // (default)" and "wrong switch set" share one line (#138).
          ctx.options?.captureOnCompact === true
          ? "switch_mismatch"
          : "off"
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
