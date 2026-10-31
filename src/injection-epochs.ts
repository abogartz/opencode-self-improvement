// Per-setup injection epochs. Host event parsing and identity binding stay in
// index.ts; this module owns frozen bytes, refresh decisions, and their status.
import { isInjectable, isActive, isVisibleTo, loadAll, malformedCount, readerFromSid, type Memory } from "./memory.ts";
import { SESSION_CAP, SessionLru } from "./sessions.ts";
import { record } from "./evidence.ts";
import {
  capToBudget,
  injectedRows,
  selectRelevant,
  storeVersion,
  systemDigest,
} from "./inject.ts";
import { attributeSession, deriveMemoryRefs, type MemoryRefs } from "./attribution.ts";
import { neverRetrieved, readLedger, useSignals } from "./hits.ts";
import { emptyStats, writeStatus, type Measured, type SessionStats, type StatusPayload } from "./status.ts";
import { callsFor } from "./triggers.ts";
import { authoredFor } from "./state.ts";

interface InjectionEpochOptions {
  budget: number;
  frontierBudget: number;
  // The host listener records usage. Eviction must still drop it with the
  // epoch and request counters, so no measurement outlives its tracked session.
  measuredTurns: Pick<Map<string, Measured>, "get" | "delete">;
  noteHits: (sid: string, rows: Memory[], query: string) => Promise<void>;
}

export function createInjectionEpochs({
  budget,
  frontierBudget: openBudget,
  measuredTurns,
  noteHits,
}: InjectionEpochOptions) {
  // Per-session frozen injection epochs: the whole memory section (digest +
  // frontier + relevance) plus the store fingerprint it was rendered from.
  // Recomputed on the first prompt of a tracked session, when injectable rows
  // change, or after a compaction (see the prompt/context/compaction hooks).
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
      reason: "first" | "store_changed";
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
    const act = all.filter(isActive);
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
      store: {
        active: act.length,
        superseded: all.length - act.length,
        open: act.filter((m) => m.status === "open").length,
        scopes: new Set(act.map((m) => m.scope)).size,
        malformed: malformedCount(),
        neverRetrieved: neverRetrieved(act, led).length,
        ledgerSince: led.since,
      },
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
    return (await loadAll()).filter((m) => isInjectable(m) && isVisibleTo(m, reader));
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
  ): Promise<{ parts: string[]; block: string; prefix: string; rode: Memory[]; refs: MemoryRefs }> => {
    const parts: string[] = [];
    await systemDigest(
      { sessionID: sid },
      { system: parts },
      { rows: mems, frontierBudget: openBudget },
    );
    const prompt = promptOverride ?? (sid === undefined ? "" : latestPrompt.get(sid) ?? "");
    // Widen the candidate pool, then cap: the budget decides what rides.
    const sel = await selectRelevant(prompt, 5, mems, await useSignals());
    const block = sel.block ? capToBudget(sel.block, budget) : "";
    // Refs the ACTUALLY-injected rows assert (paths + commands), the join key
    // for attribution. Derived from the budget-surviving rows, not the wider
    // candidate pool — crediting paths the model never saw would overclaim.
    const rode = injectedRows(block, sel.selected);
    const prefix = [...parts, block].join("\u0000");
    return { parts, block, prefix, rode, refs: deriveMemoryRefs(rode) };
  };
  const refreshEpoch = async (sid: string, rows?: Memory[]): Promise<void> => {
    if (!latestPrompt.has(sid)) return;
    const mems = rows ?? (await injectableRows(sid));
    const version = await storeVersion(mems);
    const cached = epoch.get(sid);
    // Cheap pre-check: no injectable row moved, so the frozen bytes still
    // stand. Skips re-scoring and the use-ledger write on ordinary turns.
    if (cached?.version === version) return;
    const built = await buildMemorySection(sid, mems);
    // The store moved. A write that changes nothing RENDERED — a row that is
    // not relevant to this prompt, supersession elsewhere, a scope the reader
    // never sees rendered identically — must not cost this session a prompt
    // cache. Adopt the new fingerprint, keep riding the same bytes, emit
    // nothing: an invalidation has to mean bytes actually moved.
    if (cached && cached.prefix === built.prefix) {
      epoch.set(sid, { ...cached, version });
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
      const extra = mems.filter((m) => mine.has(m.ts) && !cached.ownRows.has(m.ts));
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
    const prompt = latestPrompt.get(sid) ?? "";
    // Use ledger (#42): the rows that actually rode the block, credited with
    // the terms the prompt and those rows shared (never the prompt itself).
    // Only once the build is ADOPTED — a discarded rebuild must not credit
    // rows that were already offered under the frozen epoch.
    await noteHits(sid, built.rode, prompt);
    const at = new Date().toISOString();
    const reason: "first" | "store_changed" = cached ? "store_changed" : "first";
    epoch.set(sid, {
      version,
      parts: built.parts,
      block: built.block,
      prefix: built.prefix,
      ownRows: new Set(mems.filter((m) => authoredFor(sid).has(m.ts)).map((m) => m.ts)),
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
      },
      false,
    );
    epochRecomputes++;
    // Ledger: a store_changed recompute of a live epoch is an
    // invalidation (the first epoch of a session busts nothing). The
    // epoch request count restarts with the new block.
    const st = statsFor(sid);
    st.epochRequests = 0;
    if (reason === "store_changed") {
      st.invalidations++;
      st.lastInvalidation = { at, reason };
    }
    // Status hand-off for the terminal panel (src/tui.tsx) and any
    // out-of-process surface. Best-effort; never breaks injection.
    await flushStatus(sid);
  };

  // Push each part in the original order. Accounting follows delivery so a
  // throwing host callback leaves request accounting unchanged.
  const deliver = async (sid: string | undefined, push: (text: string) => void): Promise<void> => {
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
