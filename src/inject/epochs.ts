// Per-setup injection epochs. Host event parsing and identity binding stay in
// index.ts; this module owns frozen bytes, refresh decisions, and their status.
import { loadAll, malformedCount } from "../store/files/load.ts";
import { type Memory } from "../store/model/memory.ts";
import { isInjectable } from "../store/model/predicates.ts";
import { isVisibleTo, readerFromSid } from "../store/model/visibility.ts";
import { SESSION_CAP, SessionLru } from "../core/lru.ts";
import { captureEvidenceContext, record } from "../evidence/record.ts";
import { capToBudget, injectedRows } from "./budget.ts";
import { systemDigest } from "./digest.ts";
import { storeVersion } from "./version.ts";
import { isUserGuided, selectRelevant } from "../recall/relevant.ts";
import {
  attributeSession,
  deriveMemoryRefs,
  type MemoryRefs,
} from "./attribution.ts";
import { readLedger, useSignals } from "../hits/ledger.ts";
import { summarizeStore } from "../status/store-summary.ts";
import {
  emptyStats,
  type Measured,
  type SessionStats,
  type StatusPayload,
} from "../status/payload.ts";
import { writeStatus } from "../status/write.ts";
import { callsFor } from "../capture/triggers.ts";
import { authoredFor } from "../core/state.ts";

interface InjectionEpochOptions {
  budget: number;
  frontierBudget: number;
  /**
   * Contradiction surface (POC): code-check guided rows at render time.
   * Enabled by default; `contradictionSurface: false` skips workspace checks.
   */
  contradictionSurface?: boolean;
  // The host listener records usage. Eviction must still drop it with the
  // epoch and request counters, so no measurement outlives its tracked session.
  measuredTurns: Pick<Map<string, Measured>, "get" | "delete">;
  /** Evict the per-message usage ledger (#394) with the session. */
  forgetUsage?: (sid: string) => void;
  noteHits: (sid: string, rows: Memory[], query: string) => Promise<void>;
}

export function createInjectionEpochs({
  budget,
  frontierBudget: openBudget,
  contradictionSurface = true,
  measuredTurns,
  forgetUsage,
  noteHits,
}: InjectionEpochOptions) {
  // Per-session frozen injection epochs: the whole memory section (digest +
  // frontier + relevance) plus the store fingerprint it was rendered from.
  // Recomputed on the first prompt of a tracked session, when injectable rows
  // change, when a new prompt re-scores the block (#335), or after a
  // compaction (see the prompt/context/compaction hooks).
  // The RENDERED BYTES, not the fingerprint, decide whether the epoch moved
  // (issue #162): a write that changes nothing the model is shown must not
  // cost the next request a full re-prefill. And a pure addition the session
  // wrote itself does not move them either (#165) — see refreshEpoch. The
  // shared LRU below may evict the whole session state; a later prompt starts
  // it fresh.
  const epoch = new Map<
    string,
    {
      version: string;
      /** Frozen standing digest + frontier + convergence parts, in push order. */
      parts: string[];
      /** The budgeted relevance block the surfaces report against injectBudget. */
      block: string;
      /** Comparison key: every byte of the memory section, joined. */
      prefix: string;
      /**
       * Rows THIS session had already authored when these bytes were rendered
       * (#165). The riding-bytes test subtracts everything authored after this
       * snapshot; if what remains renders identically, the whole difference is
       * the session's own additions and the bytes keep riding.
       */
      ownRows: Set<string>;
      /**
       * The prompt these bytes were scored against. The counterfactual below
       * has to re-score the SAME inputs, or a topic change between the freeze
       * and the next write would look like a content change — and the epoch
       * would pay for a refresh it deliberately refuses to do on a prompt.
       */
      prompt: string;
      at: string;
      reason: "first" | "store_changed" | "prompt_reveal";
      refs: MemoryRefs;
    }
  >();
  // Latest user prompt per tracked session. A changed store is re-scored
  // against it even when the change happened during a tool loop with no new
  // prompt. It is evicted together with the epoch and session ledgers.
  const latestPrompt = new Map<string, string>();
  // Recomputes since server start: every one invalidated a prompt cache, so
  // it is the honest cost number the surfaces show (status files / tools).
  let epochRecomputes = 0;

  // Per-session ledger, incremented at the injection decision below. Status
  // combines it with the host listener's measured usage, either on disk (TUI)
  // or directly through memory_status.
  const sessionStats = new Map<string, SessionStats>();
  // Epoch, prompt, counters, and host measurements are evicted together.
  const sessions = new SessionLru(SESSION_CAP, (sid) => {
    epoch.delete(sid);
    latestPrompt.delete(sid);
    sessionStats.delete(sid);
    measuredTurns.delete(sid);
    forgetUsage?.(sid);
  });
  const statsFor = (sid: string): SessionStats => {
    let st = sessionStats.get(sid);
    if (!st) {
      st = emptyStats();
      sessionStats.set(sid, st);
    }
    return st;
  };

  // Build the full status snapshot for one session, or null before its first
  // epoch. Store counts are computed fresh so every flush is current.
  const buildPayload = async (sid: string): Promise<StatusPayload | null> => {
    const ep = epoch.get(sid);
    if (!ep) return null;
    const all = await loadAll();
    const led = await readLedger();
    return {
      at: ep.at,
      sessionID: sid,
      reason: ep.reason,
      recomputes: epochRecomputes,
      block: ep.block,
      blockChars: ep.block.length,
      sectionChars: ep.prefix.length,
      budget,
      store: summarizeStore(all, led, malformedCount()).counts,
      stats: statsFor(sid),
      measured: measuredTurns.get(sid) ?? null,
      attribution: attributeSession(callsFor(sid), ep.refs),
    };
  };
  const flushStatus = (sid: string): Promise<void> =>
    buildPayload(sid).then((p) => (p ? writeStatus(p) : undefined));

  // Called when a prompt arrives (to keep status surfaces current) and again
  // at the injection decision on every model request. The latter keeps
  // removals fail-closed: an out-of-band redaction or a block during a tool
  // loop cannot ride one more request waiting for another user prompt.
  // The caller's sid is resolved to an immutable Reader BEFORE the store
  // read (#127): while loadAll awaits, another session's hooks may dispatch
  // and move the ambient current; filtering with THAT leaks the other
  // session's repo into this one's system prompt.
  const injectableRows = async (sid?: string): Promise<Memory[]> => {
    const reader = readerFromSid(sid);
    return (await loadAll()).filter(
      (m) => isInjectable(m) && isVisibleTo(m, reader),
    );
  };
  // Render the COMPLETE memory section for one request: the standing digest,
  // the open-thread frontier and the convergence line (all from systemDigest),
  // followed by this epoch's relevance block. The parts are exactly what gets
  // pushed onto `event.system`; their join is the byte key the epoch compares
  // against, so "did the cache-critical prefix change?" is answered by the
  // bytes the model would actually see and never by a proxy (issue #162).
  const buildMemorySection = async (
    sid: string | undefined,
    mems: Memory[],
    promptOverride?: string,
  ): Promise<{
    parts: string[];
    block: string;
    prefix: string;
    rode: Memory[];
    refs: MemoryRefs;
    /** Guided rows the selector put in the block (pre-budget), by ts. */
    guidedIds: string[];
    /** Guided rows that survived the budget, by ts. */
    guidedRodeIds: string[];
    /** Guided rows visible to this reader in the store. */
    guidedSeen: number;
    /** A CONFLICT line rendered in this block. */
    conflict: boolean;
  }> => {
    const parts: string[] = [];
    await systemDigest(
      { sessionID: sid },
      { system: parts },
      { rows: mems, frontierBudget: openBudget },
    );
    const prompt =
      promptOverride ??
      (sid === undefined ? "" : (latestPrompt.get(sid) ?? ""));
    // Widen the candidate pool, then cap: the budget decides what rides.
    // The guided cap (#335) rides user-stated rows ahead of the lexical picks;
    // the char budget below still bounds the whole block. The conflict check
    // reads the session's OWN repo directory (its reader's scope) — never an
    // ambient one (#127's rule applies to code reads too).
    const reader = readerFromSid(sid);
    const sel = await selectRelevant(
      prompt,
      5,
      mems,
      await useSignals(),
      undefined,
      {
        guidedCap: 3,
        // #388: budget the RIDING set by priority here, before the block is
        // rendered in canonical order. Capping the rendered string (the old
        // path) made recency decide who got dropped, because the newest row is
        // now always first.
        budget,
        ...(contradictionSurface
          ? {
              conflictCheck: true,
              ...(reader.kind === "repo" ? { repoDir: reader.scope.path } : {}),
            }
          : {}),
      },
    );
    // UNREACHABLE today, not a guard: `selectRelevant` was handed the same
    // `budget` and builds the block as header + Σ(1 + line) over lines it
    // accepted while that running sum stayed ≤ budget, and every line length is
    // non-negative. So a non-empty `sel.block` is already ≤ budget, capToBudget
    // keeps every line, and this call returns its argument unchanged. No test
    // can reach a different result; it stays only as a byte bound on the text
    // that rides the prompt if a future caller stops budgeting inside the
    // selector.
    const block = sel.block ? capToBudget(sel.block, budget) : "";
    // Refs the ACTUALLY-injected rows assert (paths + commands), the join key
    // for attribution. Derived from the budget-surviving rows, not the wider
    // candidate pool — crediting paths the model never saw would overclaim.
    const rode = injectedRows(block, sel.selected, sel.rendered);
    const prefix = [...parts, block].join("\u0000");
    // Ledger terms/identities belong to the stored rows, but coverage refs
    // must describe only the text the model actually received.
    // Stage telemetry (mystery 2): split the hint channel's journey into the
    // three links a miss can die at — visible in the store (guidedSeen),
    // selected into the block (guidedIds), survived the budget (guidedRodeIds)
    // — so an L6h wire miss joins to exactly one cause from the evidence log.
    const guidedSeen = mems.filter(isUserGuided).length;
    const guidedIds = sel.selected.filter(isUserGuided).map((m) => m.ts);
    const guidedRodeIds = rode.filter(isUserGuided).map((m) => m.ts);
    const conflict = block.includes("CONFLICT (");
    return {
      parts,
      block,
      prefix,
      rode,
      refs: deriveMemoryRefs(rode.map((m) => sel.rendered.get(m) ?? m)),
      guidedIds,
      guidedRodeIds,
      guidedSeen,
      conflict,
    };
  };
  const refreshEpoch = async (sid: string, rows?: Memory[]): Promise<void> => {
    if (!latestPrompt.has(sid)) return;
    const evidenceContext = captureEvidenceContext(sid);
    const mems = rows ?? (await injectableRows(sid));
    const version = await storeVersion(mems);
    const cached = epoch.get(sid);
    const prompt = latestPrompt.get(sid) ?? "";
    // Cheap pre-check: no injectable row moved AND the frozen bytes were
    // already scored against THIS prompt. Skips re-scoring and the use-ledger
    // write on ordinary turns and on every tool-loop request within a turn.
    // A new prompt does re-score (#335, the epoch-freeze flaw): a block
    // frozen at the first request carried the first topic's rows for the
    // whole session and never picked up the rows a later prompt genuinely
    // matches. Cache is still safe — the epoch only MOVES when the rendered
    // bytes actually change, and a prompt change that keeps the same rows
    // adopts silently below.
    if (cached?.version === version && cached.prompt === prompt) return;
    const built = await buildMemorySection(sid, mems);
    // The store and/or the prompt moved. A change that alters nothing
    // RENDERED — a row that is not relevant to this prompt, supersession
    // elsewhere, a scope the reader never sees rendered identically — must
    // not cost this session a prompt cache. Adopt the new fingerprint and
    // prompt, keep riding the same bytes, emit nothing: an invalidation has
    // to mean bytes actually moved.
    if (cached && cached.prefix === built.prefix) {
      epoch.set(sid, { ...cached, version, prompt });
      return;
    }
    // Riding bytes (#165): a pure addition this session wrote itself is
    // information it already has — the model produced it, it is in the
    // transcript. Re-render the section with every row authored SINCE these
    // bytes were frozen taken back out: if it comes back byte-identical, the
    // entire difference is attributable to the session's own additions and
    // the frozen bytes keep riding. Everything else survives into that render
    // and still busts — a riding row removed or rewritten (blocklist,
    // hand-redaction, forget, supersession, decay), another session's row, a
    // viewer edit, an import, a moved convergence line.
    if (cached) {
      const mine = authoredFor(sid);
      const extra = mems.filter(
        (m) => mine.has(m.ts) && !cached.ownRows.has(m.ts),
      );
      if (extra.length) {
        const back = await buildMemorySection(
          sid,
          mems.filter((m) => !extra.some((e) => e.ts === m.ts)),
          cached.prompt,
        );
        if (back.prefix === cached.prefix) {
          epoch.set(sid, { ...cached, version });
          return;
        }
      }
    }
    // Use ledger (#42): the rows that actually rode the block, credited with
    // the terms the prompt and those rows shared (never the prompt itself).
    // Only once the build is ADOPTED — a discarded rebuild must not credit
    // rows that were already offered under the frozen epoch.
    await noteHits(sid, built.rode, prompt);
    const at = new Date().toISOString();
    // Which input moved decides the reason: the store outranks the prompt, so
    // a turn that did both is accounted as the (cache-critical) store change.
    const reason: "first" | "store_changed" | "prompt_reveal" = cached
      ? cached.version !== version
        ? "store_changed"
        : "prompt_reveal"
      : "first";
    epoch.set(sid, {
      version,
      parts: built.parts,
      block: built.block,
      prefix: built.prefix,
      ownRows: new Set(
        mems.filter((m) => authoredFor(sid).has(m.ts)).map((m) => m.ts),
      ),
      prompt,
      at,
      reason,
      refs: built.refs,
    });
    await record(
      "epoch_recompute",
      {
        session: sid,
        reason,
        chars: built.block.length,
        // Hint-channel attribution (mystery 2): a wire miss is one grep away.
        // guidedSeen=0 -> capture never wrote the row. guidedSeen>0 with the
        // id absent from `guided` -> the cap (newest-first, 3) dropped it.
        // In `guided` but absent from `guidedRode` -> the budget inside
        // selectRelevant dropped it (#388 moved the cap there from capToBudget).
        // In `guidedRode` yet absent from the wire -> render/transport, or a
        // paraphrased needle (now impossible for rows carrying `orig=true`).
        ...(built.guidedSeen ? { guidedSeen: built.guidedSeen } : {}),
        ...(built.guidedIds.length
          ? { guided: built.guidedIds.join(",") }
          : {}),
        ...(built.guidedRodeIds.length
          ? { guidedRode: built.guidedRodeIds.join(",") }
          : {}),
        ...(built.conflict ? { conflict: true } : {}),
      },
      false,
      sid,
      evidenceContext,
    );
    epochRecomputes++;
    // Ledger: any recompute of a live epoch that MOVED the bytes is an
    // invalidation (the first epoch of a session busts nothing; a re-score
    // that kept the bytes never reaches this line). The epoch request count
    // restarts with the new block.
    const st = statsFor(sid);
    st.epochRequests = 0;
    if (reason !== "first") {
      st.invalidations++;
      st.lastInvalidation = { at, reason };
    }
    // Status hand-off for the terminal panel (src/tui.tsx) and any
    // out-of-process surface. Best-effort; never breaks injection.
    await flushStatus(sid);
  };

  // Push each part in the original order. Accounting follows delivery so a
  // throwing host callback leaves request accounting unchanged.
  const deliver = async (
    sid: string | undefined,
    push: (text: string) => void,
  ): Promise<void> => {
    const mems = await injectableRows(sid);
    if (typeof sid === "string") await refreshEpoch(sid, mems);
    // Deliver the FROZEN memory section. Every byte pushed onto the system
    // prompt comes from the epoch, so between busts the provider sees an
    // identical prefix and serves the conversation from cache (issue #162).
    // A session with no epoch yet (no prompt recorded, or evicted from the
    // LRU) still gets the standing digest, built fresh and uncached.
    const ep = typeof sid === "string" ? epoch.get(sid) : undefined;
    if (ep) {
      for (const text of ep.parts) push(text);
    } else {
      const parts: string[] = [];
      await systemDigest(
        { sessionID: sid },
        { system: parts },
        { rows: mems, frontierBudget: openBudget },
      );
      for (const text of parts) push(text);
    }
    // This epoch's relevance-ranked memory, also on the system channel —
    // the UI never renders system parts, unlike appended prompt text.
    const knowledge = ep?.block;
    if (knowledge) push(knowledge);
    // Count AT THE INJECTION DECISION so badge/panel numbers match exactly
    // what rode this request (a later abort still rode the bytes — known
    // and documented). Abstained = the epoch exists but its block is empty.
    if (typeof sid === "string") {
      const st = statsFor(sid);
      st.requests++;
      st.epochRequests++;
      if (knowledge) st.cumChars += knowledge.length;
      else if (epoch.has(sid)) st.abstained++;
    }
  };

  return {
    // Setup touches the LRU at the same points as identity/usage handling.
    touch: (sid: string): void => sessions.touch(sid),
    async prompt(sid: string, text: string): Promise<void> {
      latestPrompt.set(sid, text);
      await refreshEpoch(sid);
    },
    // Fix A (FINDINGS 2026-11-08 §4b): a guided row promoted AFTER a session
    // froze its bytes could never enter the hint lane — the bench's run 5
    // lost the lane to a capture that landed 9 minutes into pass 2, and the
    // epoch only moves on a request that happens to notice. Recompute every
    // tracked epoch on guided promotion so the NEXT request of every session
    // carries the row and the epoch_recompute line records it. Bounded:
    // guided rows are rare (cap 3), the refresh pre-check early-returns for
    // any session whose visible rows did not move, and an untracked session
    // is a map miss.
    refreshAll(): Promise<void[]> {
      return Promise.all([...epoch.keys()].map((sid) => refreshEpoch(sid)));
    },
    deliver,
    invalidate(sid: string): void {
      epoch.delete(sid);
      latestPrompt.delete(sid);
    },
    refresh: refreshEpoch,
    buildPayload,
    flushStatus,
  };
}
