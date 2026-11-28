// Shared initialization: hosts supply ports; memory policy and store ownership stay here.
import type {
  MemoryHost,
  MemoryRuntime,
  MemorySetupOptions,
} from "../host/runtime.ts";
import type { CompactCapture } from "../host/capture.ts";
import { registerHooks, type RideAt } from "./events.ts";
import { forgetUsage } from "../status/usage.ts";
import { guarded, setGuardedFailureReporter } from "../core/hooks.ts";
import { frontierBudget, injectBudget } from "../core/config/budgets.ts";
import type { Memory } from "../store/model/memory.ts";
import { recordBestEffort } from "../telemetry/record.ts";
import { sharedTerms } from "../recall/shared-terms.ts";
import { configureAutoCapture } from "./capture.ts";
import { createInjectionEpochs } from "../inject/epochs.ts";
import { pullScopeFrom } from "../inject/pull.ts";
import { createSessionContext } from "../identity/session-context.ts";
import { registerMemoryTools } from "../tools/registry.ts";
import { recordHits, type HitSource } from "../telemetry/ledger.ts";
import type { Measured } from "../status/payload.ts";
import { peekTurn } from "../core/state.ts";
import { resolveRepo, setRepoScope } from "../identity/repokey.ts";
import { bunFloorWarning } from "../core/runtime.ts";
import { recordStartup } from "./startup.ts";
import { attributedHost } from "./harness.ts";
import { harnessName, withHarness } from "../telemetry/harness.ts";

let bunFloorChecked = false;

export function setupMemory(
  host: MemoryHost,
  config: MemorySetupOptions = {},
): Promise<MemoryRuntime> {
  const harness = harnessName(host.harness);
  return withHarness(harness, async () => {
    const runtime = await setupAttributedMemory(attributedHost(host), config);
    return {
      get capabilities() {
        return runtime.capabilities;
      },
      dispose: () => withHarness(harness, () => runtime.dispose()),
    };
  });
}

async function setupAttributedMemory(
  host: MemoryHost,
  { directory: setupRoot, options = {} }: MemorySetupOptions = {},
): Promise<MemoryRuntime> {
  // Identity vs verification tree are separate concerns: the repo STAMP is
  // resolved per session from the event stream (never from process.cwd(),
  // which is the server launch dir and poisons rows invisibly); cwd remains
  // only as the gate's verification tree when no session location is known.
  const liveRoot = setupRoot ?? process.cwd();
  // mirror every swallowed guarded() failure into the evidence file.
  // Hook name + error class ONLY — never the message, which can carry
  // conversation content. A failed mirror counts as a dropped diagnostic.
  setGuardedFailureReporter((name, err) =>
    recordBestEffort(
      "hook_error",
      {
        hook: name,
        error:
          err instanceof Error ? err.constructor?.name || "Error" : typeof err,
      },
      false,
    ),
  );
  setRepoScope(setupRoot ? resolveRepo(setupRoot) : null);
  // THIS instance's own workspace. The module scope says who loaded last;
  // this says who I am. An unbound session that calls into THIS instance
  // resolves here — never to another instance's scope (multi-setup).
  const instanceDir =
    typeof setupRoot === "string" && setupRoot ? setupRoot : undefined;

  // Character budgets: relevance injection and contextual pulls share the
  // existing cap; the session-start frontier has its own larger cap. Plugin
  // options win over env fallbacks, and the frontier defaults to 3x the
  // effective injection budget.
  const budget = Number(options.injectBudget) || injectBudget();
  const openBudget = Number(options.frontierBudget) || frontierBudget(budget);

  // Warn-once Bun floor check (same setup-time warning style as the
  // captureModel warnings below): the store code's
  // fs failure modes are Bun-version dependent, so flag an old host.
  if (!bunFloorChecked) {
    bunFloorChecked = true;
    const floorWarning = bunFloorWarning(
      typeof Bun === "undefined" ? undefined : Bun.version,
    );
    if (floorWarning) console.warn(floorWarning);
  }

  await host.installCommands?.();

  const {
    gateContext,
    ownerlessWriter,
    refuseOwnerlessWrite,
    toolIds,
    bindSessionFromApi,
    bindSessionIdentity,
  } = createSessionContext(host.tools.directories, { instanceDir, liveRoot });

  // ---- tools --------------------------------------------------------------
  // Use ledger. `query` is what retrieval was asked with; what gets
  // stored is the vocabulary the answer SHARES with the query, taken from the
  // memory side, so the ledger can never become a copy of user prompts.
  // Fail-soft inside recordHits: telemetry must not break a read path.
  const noteHits = async (
    src: HitSource,
    sid: string,
    rows: Memory[],
    query: string,
    // Deferred pull credits retain the original turn and throttle window.
    at?: RideAt,
  ): Promise<void> => {
    if (!rows.length || !query.trim()) return;
    const terms: string[] = [];
    for (const m of rows)
      for (const t of sharedTerms(query, m))
        if (!terms.includes(t)) terms.push(t);
    // the turn is what joins a ride to the outcome of that same turn.
    // Read, never created-for: markTurn has already run for any session that
    // can reach a read path, so this does not seed state.
    const observed = at ? { turn: at.turn, key: at.turnKey } : peekTurn(sid);
    await recordHits(
      src,
      sid,
      rows,
      terms,
      at?.placedAt ?? Date.now(),
      observed?.turn,
      observed?.key,
      at,
    );
  };
  // The host listener owns measured usage; the epoch controller drops it
  // alongside its own maps when the shared session LRU evicts an entry.
  const measuredTurns = new Map<string, Measured>();
  const sessions = createInjectionEpochs({
    budget,
    frontierBudget: openBudget,
    // Code-check guided claims by default; explicit false opts out.
    contradictionSurface: options.contradictionSurface !== false,
    measuredTurns,
    forgetUsage,
    noteHits: (sid, rows, query) => noteHits("inject", sid, rows, query),
  });
  const flushStatus = sessions.flushStatus;

  await host.tools.registerTools((editor) =>
    registerMemoryTools(editor, {
      toolIds,
      bindSessionIdentity,
      ownerlessWriter,
      refuseOwnerlessWrite,
      gateContext,
      sessions,
      noteHits,
    }),
  );
  // ---- hooks (all fail-closed) -------------------------------------------
  // Seam set by the auto-capture wiring below ONLY when the compaction
  // trigger is live (autoCapture not false, captureOnCompact not false, and a
  // model that resolves — the option, the session, or the host default). The
  // compaction hook calls it fire-and-forget; undefined means "off".
  // Declared here because the hook registers before capture.
  let onCompactCapture: CompactCapture | undefined;

  const lifecycle = await registerHooks(host.lifecycle, {
    guarded,
    sessions,
    instanceDir,
    budget,
    noteHits,
    bindSessionIdentity,
    bindSessionFromApi,
    measuredTurns,
    flushStatus,
    // Which tool results carry a pull, and what the pull searches. Measured
    // default in src/inject/pull.ts; `pullOutputChars: 0` in the plugin config
    // restores the old arguments-only behaviour, `pullTools` narrows the set,
    // and `pullTools: []` switches the channel off. A value that does not
    // parse falls back to the measured default and says so on the console —
    // the same setup-time warning style as the Bun floor and captureModel
    // checks above, because a config line that silently does nothing is the
    // failure nobody debugs.
    pullScope: pullScopeFrom(options, (message) =>
      console.warn(`[opencode-self-improvement] ${message}`),
    ),
    getCompactCapture: () => onCompactCapture,
  });

  let capture: ReturnType<typeof configureAutoCapture> | undefined;
  let cleanup: Promise<void> | undefined;
  const runtime: MemoryRuntime = {
    get capabilities() {
      const offered = host.capture;
      return {
        ...host.capabilities,
        capture: {
          turnEnd: typeof offered.turnEndEvents === "function",
          transcript: typeof offered.readTranscript === "function",
          generation: typeof offered.generateText === "function",
          defaultModel: typeof offered.defaultModel === "function",
        },
      };
    },
    dispose() {
      if (cleanup) return cleanup;
      // Start both synchronously, even if one disposer throws. Wait for both
      // before reporting failure so callers can safely release the store.
      const hooksDone = (async () => lifecycle.dispose())();
      const captureDone = (async () => capture?.cleanup?.())();
      cleanup = Promise.allSettled([hooksDone, captureDone]).then((results) => {
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length)
          throw new AggregateError(errors, "Memory runtime cleanup failed");
      });
      return cleanup;
    },
  };
  try {
    const captureHost = host.capture;
    capture = configureAutoCapture(captureHost, options, {
      instanceDir,
      gateContext,
      guarded,
      // A guided promotion updates every tracked session's next request.
      onGuidedPromoted: async () => {
        await sessions.refreshAll();
      },
    });
    onCompactCapture = capture.onCompactCapture;
    await recordStartup(captureHost, options);
    return runtime;
  } catch (error) {
    try {
      await runtime.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Memory runtime setup and cleanup failed",
      );
    }
    throw error;
  }
}
