// opencode-self-improvement: one opencode plugin bundling durable memory, the
// 4-gate write pipeline, deterministic reflection triggers T1/T2/T4,
// tiny-digest injection with deterministic memory-first context and
// contextual pull, and snapshot/rollback.
//
// V2 port: registers tools via `ctx.tool.transform` (JSON Schema), mirrors the
// V1 hooks onto the OpenCode V2 session/tool hook API, and registers the
// /repo-init command via `ctx.command.transform`. The plugin contract is a
// default export object `{ id, setup(ctx) }` (OpenCode >= 2.0), pinned at
// compile time against the real SDK type (`@opencode/plugin`, type-only — see
// the note on `plugin` below). All business logic still lives in the decoupled
// helper modules.
import type { Cleanup, Plugin } from "@opencode/plugin/promise/plugin";
import { basename, join } from "node:path";
import { evidenceDir, frontierBudget, injectBudget, memoryRoot, dateStr } from "./config.ts";
import { STATUSES, TYPES } from "./types.ts";
import {
  clearSuperseded,
  isActive,
  isVisibleHere,
  loadAll,
  malformedCount,
  markSuperseded,
  resolveMemoryTarget,
  snapshotFiles,
  type Memory,
} from "./memory.ts";
import { runWriteGate, type GateContext, type WriteCandidate } from "./gates.ts";
import { pruneMemory } from "./prune.ts";
import { exportMemories, findStaleOpen, importMemories } from "./portable.ts";
import { listSnapshots, restoreSnapshot } from "./undo.ts";
import { SESSION_CAP, SessionLru } from "./sessions.ts";
import { record, recordCaptureLag } from "./evidence.ts";
import { proposeConsolidations, renderProposals } from "./consolidate.ts";
import { readReads } from "./hits.ts";
import {
  capToBudget,
  compactionAnchor,
  contextualPull,
  formatMemory,
  injectedRows,
  pullQuery,
  selectRelevant,
  sharedTerms,
  storeVersion,
  systemDigest,
} from "./inject.ts";
import { attributeSession, deriveMemoryRefs, type MemoryRefs } from "./attribution.ts";
import { readLedger, neverRetrieved, recordHits, useSignals, type HitSource } from "./hits.ts";
import { formatInit, runInit } from "./init.ts";
import { ensureInitCommand, ensureMemoryReportCommand } from "./command.ts";
import {
  blockedRecent,
  emptyStats,
  renderMemoryReport,
  writeStatus,
  type Measured,
  type SessionStats,
  captureLag,
  captureLagLines,
  rowsPerDay,
  type StatusPayload,
  type StoreCounts,
} from "./status.ts";
import {
  afterTool,
  callsFor,
  checkNewSession,
  evidenceCalls,
  firstFrontierTap,
  hasEngagement,
  hasGateCheck,
  markFrontierTap,
  markTurn,
  onCompacting,
} from "./triggers.ts";
import { getCurrent, setCurrent } from "./state.ts";
import { resolveRepo, setRepoScope, rememberSessionDir, sessionDir } from "./repokey.ts";
import { readLines } from "./logfmt.ts";
import { buildCapturePrompt, flattenTranscript, lagSince, parseCandidates, parseModelRef } from "./capture.ts";
import { redactSecrets } from "./secrets.ts";
import { flattenMemoryText } from "./sanitize.ts";
import { bunFloorWarning } from "./runtime.ts";

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
  command?: {
    transform: (cb: (editor: { add: (cmd: Record<string, unknown>) => void }) => void) => Promise<unknown>;
  };
  session?: {
    hook: (name: string, cb: (event: any) => Promise<void> | void) => Promise<HookReg | void>;
    prompt: (input: {
      sessionID: string;
      text: string;
      delivery?: "steer" | "queue";
    }) => Promise<unknown>;
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
    setRepoScope(setupRoot ? resolveRepo(setupRoot) : null);

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

    const gateContext = (): GateContext => ({
      liveRoot: sessionDir(getCurrent().sid) ?? liveRoot,
      evidenceCalls: evidenceCalls(getCurrent().sid),
      hasGateCheck: hasGateCheck(getCurrent().sid),
      hasEngagement: hasEngagement(getCurrent().sid),
    });

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
      if (!sid || sid === "?" || sessionDir(sid) || bindingSids.has(sid)) return;
      bindingSids.add(sid);
      try {
        const msgs = await ctx.session?.context?.({ sessionID: sid });
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            if (!m || typeof m !== "object") continue;
            const r = m as Record<string, any>;
            const dir = r.location?.directory ?? r.info?.location?.directory;
            if (typeof dir === "string" && dir) {
              rememberSessionDir(sid, dir);
              break;
            }
          }
        }
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
      if (!sid || sid === "?" || sessionDir(sid) || apiBindTried.has(sid)) return;
      apiBindTried.add(sid);
      apiBindOrder.touch(sid);
      try {
        const got = (await ctx.session?.get?.({ sessionID: sid })) as Record<string, any> | undefined;
        const row = (got?.data ?? got) as Record<string, any> | undefined;
        const dir = row?.location?.directory ?? row?.directory;
        if (typeof dir === "string" && dir) rememberSessionDir(sid, dir);
      } catch {
        // no session.get on this host (or unknown session): stay unbound
      }
    }

    // Identity must resolve BEFORE a row is stamped or a read is partitioned:
    // try the (legacy) message payloads, then the session row.
    async function bindSessionIdentity(sid: string | undefined): Promise<void> {
      if (!sid || sid === "?" || sessionDir(sid)) return;
      await bindSessionFromMessages(sid);
      if (!sessionDir(sid)) await bindSessionFromApi(sid);
    }

    // ---- tools --------------------------------------------------------------
    await ctx.tool?.transform((editor) => {
      const direct = { codemode: false } as const;

      editor.add(validated(RememberArgs, {
        name: "memory_remember",
        description:
          "Store a memory after the 4-gate write pipeline validates it (canonical graph, stale refs, dupes). Blocked writes record evidence instead of persisting. Add `kw` — 3-5 aliases, synonyms, verb forms or the literal command a FUTURE session would search with — to make a row findable when the wording differs; keywords are indexed, never injected.",
        options: direct,
        async execute(args): Promise<{ content: string }> {
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
          await bindSessionIdentity(getCurrent().sid);
          const outcome = await runWriteGate(candidate, gateContext());
          if (outcome.action === "promoted") return { content: `Remembered: ${args.type} in ${args.scope}` };
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
        async execute(args): Promise<{ content: string }> {
          const all = (await loadAll()).filter(isActive).filter(isVisibleHere);
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
        async execute(args): Promise<{ content: string }> {
          await bindSessionIdentity(getCurrent().sid);
          const summary = await runInit({ liveRoot: gateContext().liveRoot, force: args.force, mode: args.mode });
          return { content: formatInit(summary) };
        },
      }));

      editor.add(validated(RecallArgs, {
        name: "memory_recall",
        description:
          "Look up durable project knowledge — build/test/lint commands, decisions, patterns, preferences, blockers — BEFORE searching the repo or reading files. Use for 'how do I run X', conventions, and past decisions. By scope, type, or free-text query; with no filters it returns the most recent memories.",
        options: direct,
        async execute(args): Promise<{ content: string }> {
          let results = (await loadAll()).filter(isActive).filter(isVisibleHere);
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
            const cur = getCurrent();
            markFrontierTap(cur.sid, cur.call);
            await record("frontier_tapped", {
              n_open: openIn,
              in_results: limited.length,
              turn: firstFrontierTap(cur.sid)?.turn,
            });
          }
          if (args.query) await noteHits("recall", getCurrent().sid, limited, args.query);
          return { content: `Found ${results.length} (${total} total)\n\n${limited.map(formatMemory).join("\n")}` };
        },
      }));

      editor.add(validated(UpdateArgs, {
        name: "memory_update",
        description:
          "Update an existing memory (gated like remember; the prior entry is superseded, not erased). `query` selects which row to update: its exact id (ts), a clock fragment (e.g. HH:MM:SS.mmm), or a unique substring of its content. Omitting `query` targets the most recent active row of scope+type. An unmatched or ambiguous `query` fails closed and writes nothing.",
        options: direct,
        async execute(args): Promise<{ content: string }> {
          await bindSessionIdentity(getCurrent().sid);
          const prior = (await loadAll()).filter(
            (m) => m.scope === args.scope && m.type === args.type && isActive(m) && isVisibleHere(m),
          );
          // Resolve the row BEFORE the gate: an update that cannot identify its
          // target must write nothing, rather than silently superseding whichever
          // row happened to be newest in this scope+type.
          const resolved = resolveMemoryTarget(prior, args.query);
          if (resolved.status === "not_found") {
            const where = args.query ? ` matches ${JSON.stringify(args.query)}` : "";
            return {
              content: `memory_update blocked: no active ${args.type} row in ${args.scope}${where}. Nothing was written.`,
            };
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
          const outcome = await runWriteGate(
            { type: args.type, scope: args.scope, content: args.content, kw: args.kw, status: args.status },
            gateContext(),
          );
          if (outcome.action === "promoted" && outcome.ts && target) {
            await markSuperseded(target.ts, {
              superseded_by: outcome.ts,
              reason: "update",
              symbol: target.ts,
              from: target.ts,
              to: outcome.ts,
            });
            return { content: `Updated ${args.type} in ${args.scope} (superseded ${target.ts})` };
          }
          if (outcome.action === "promoted") return { content: `Remembered: ${args.type} in ${args.scope}` };
          if (outcome.action === "collapsed") return { content: `Duplicate ignored: ${args.type}/${args.scope}` };
          return { content: `Write blocked at GATE (${outcome.reason}). ${outcome.hint ?? ""}`.trimEnd() };
        },
      }));

      editor.add(validated(ForgetArgs, {
        name: "memory_forget",
        description:
          "Delete memories by scope and type. Snapshots first, logs the reason for audit, never touches a repo.",
        options: direct,
        async execute(args): Promise<{ content: string }> {
          const res = await pruneMemory(args.scope, args.type, args.reason);
          if (!res.deleted.length) return { content: `No memories found for ${args.type} in ${args.scope}` };
          return { content: `Deleted ${res.deleted.length} ${args.type} memory(s) from ${args.scope}. Audit: ${res.audit}` };
        },
      }));

      editor.add(validated(EmptyArgs, {
        name: "memory_list",
        description: "List memory scopes and types for discovery.",
        options: direct,
        async execute(): Promise<{ content: string }> {
          const mems = (await loadAll()).filter(isActive).filter(isVisibleHere);
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
          "List memory snapshots, or restore one (rollback). Only snapshots inside this store's snapshots directory are accepted: pass a bare name from the list or its full path. Non-standard files in snapshots/ are not listed or restorable. SAFE BY DEFAULT: restore refuses if the current file has rows added or edited since the snapshot, and audited human/tool deletions stay deleted. Re-run with merge=true to restore AND keep divergent rows, or force=true for an explicit exact rollback. Blocklisted rows remain inactive in every mode.",
        options: direct,
        async execute(args): Promise<{ content: string }> {
          if (args.snapshot) {
            const mode = args.force ? "force" : args.merge ? "merge" : "check";
            const res = await restoreSnapshot(args.snapshot, memoryRoot(), mode);
            if (!res.restored) {
              const parts = [...res.concurrentAdded, ...res.concurrentChanged];
              return {
                content:
                  `Undo refused: ${res.concurrentAdded.length} row(s) added and ` +
                  `${res.concurrentChanged.length} changed since this snapshot — restoring it ` +
                  `would clobber them. Divergent rows (ts): ${parts.join(", ")}. ` +
                  `If those belong to another session, re-run with merge=true (restore the file ` +
                  `AND keep them); if they are the writes you are undoing, use force=true.`,
              };
            }
            const kept = res.mode === "merge" && (res.concurrentAdded.length || res.concurrentChanged.length)
              ? ` Kept ${res.concurrentAdded.length} added / ${res.concurrentChanged.length} changed row(s) written after the snapshot.`
              : "";
            const safety = res.safety ? ` Pre-restore file snapshotted -> ${res.safety}.` : "";
            const omitted = res.deletedOmitted.length
              ? ` Omitted ${res.deletedOmitted.length} deliberately deleted row(s); use force=true to recover them.`
              : "";
            return { content: `Restored ${basename(res.target)} from ${res.mode} snapshot -> ${res.target}.${kept}${safety}${omitted}` };
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
        async execute(args): Promise<{ content: string }> {
          const file = join(evidenceDir(), `${args.date || dateStr()}.logfmt`);
          let lines = await readLines(file);
          if (args.ev) lines = lines.filter((l) => l.includes(`ev=${args.ev}`));
          if (!lines.length) return { content: "No evidence" };
          const limit = args.limit || 50;
          return { content: lines.slice(-limit).join("\n") };
        },
      }));

      editor.add(validated(MergeReviewArgs, {
        name: "memory_merge_review",
        description:
          "Resolve an open merge/review gate non-destructively: mark the loser as superseded_by the survivor, and clear any supersession the survivor itself carries so the canonical row stays recallable. Both rows stay active data (the loser is recoverable via memory_undo); nothing is deleted. Fails closed (no partial apply) when the reason or the survivor id is missing, or the loser is already superseded.",
        options: direct,
        async execute(args): Promise<{ content: string }> {
          if (!args.loser || !args.survivor || !args.reason) {
            return { content: "merge_review blocked: loser, survivor, and reason are all required (fail-closed)." };
          }
          const ok = await markSuperseded(args.loser, {
            superseded_by: args.survivor,
            reason: args.reason,
            symbol: args.loser,
            from: args.loser,
            to: args.survivor,
          });
          if (!ok) {
            return { content: "merge_review: loser not found or already superseded — nothing to resolve. No evidence written." };
          }
          // The survivor may itself have been superseded earlier (e.g. by a row
          // this very call just made the loser). Declaring it canonical has to
          // make it recallable, so clear its own marker too.
          const revived = await clearSuperseded(args.survivor);
          return {
            content:
              `Resolved merge: ${args.survivor} is canonical; ${args.loser} superseded (recoverable via memory_undo). ` +
              (revived ? `Survivor's own supersession cleared, it is active again. ` : "") +
              `Evidence recorded for reason='${args.reason}'.`,
          };
        },
      }));

      editor.add(validated(ExportArgs, {
        name: "memory_export",
        description:
          "Export active memories as a JSONL file for backup or transfer to another machine. The first line is a metadata header ({_export,version,exportedAt,count}); each later line is one JSON object {ts,type,scope,content,status,tags,issue}. The header is what lets memory_import keep repo-scoped status:\"open\" frontier rows — a hand-written file without it imports such rows as settled, as does an imported open row claiming repo:\"global\". Defaults to <memory-root>/exports/<timestamp>.jsonl; pass `file` to choose the path, `scope` to export one scope. Superseded rows are not exported (history stays in the store).",
        options: direct,
        async execute(args): Promise<{ content: string }> {
          const res = await exportMemories({ scope: args.scope, file: args.file });
          return { content: `Exported ${res.count} memories -> ${res.path}` };
        },
      }));

      editor.add(validated(ImportArgs, {
        name: "memory_import",
        description:
          "Import memories from a JSONL export (see memory_export). Every row goes through the same 4-gate write pipeline as memory_remember (tagged `import`, original tags preserved), so duplicates collapse and ungrounded rows are blocked exactly as usual — those are normal tallied outcomes, not errors. Malformed lines are skipped and counted. Frontier policy: status:\"open\" exempts a row from ref grounding, so it requires a memory_export header and cannot claim global scope; imported repo stamps are kept only when they match the importing session's repo, otherwise the importing repo is stamped. A stamped open row is downgraded when there is no current repo scope to verify it. Imported content is unverified by construction: injected rows surface a `[via import]` provenance marker.",
        options: direct,
        async execute(args): Promise<{ content: string }> {
          try {
            const t = await importMemories(args.file, (c) =>
              runWriteGate(
                { ...c, tags: [...new Set([...(c.tags ?? []), "import"])] },
                gateContext(),
              ),
            );
            return {
              content:
                `Imported ${args.file}: ${t.promoted} promoted, ${t.collapsed} duplicates collapsed, ` +
                `${t.blocked} blocked by the gate, ${t.skipped} malformed lines skipped.` +
                (t.downgraded
                  ? ` ${t.downgraded} open rows downgraded to settled (missing eligible memory_export header or verifiable repo scope).`
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
        async execute(args): Promise<{ content: string }> {
          const days = Number(args.olderThanDays) > 0 ? Number(args.olderThanDays) : 14;
          const dryRun = args.dryRun !== false; // only an explicit false mutates
          const stale = await findStaleOpen(days);
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
          // mutation. markSuperseded also snapshots internally per row; this
          // pass guarantees a pre-decay copy exists even if a later row fails.
          const snapshot = await snapshotFiles([...new Set(stale.map((m) => m.file))]);
          const retiredTs: string[] = [];
          for (const m of stale) {
            // Idempotent (a no-op on already-superseded rows), so a re-run
            // cannot double-mark. No successor row exists — decay retires.
            const ok = await markSuperseded(m.ts, { superseded_by: "decay", reason: "decay" });
            if (ok) retiredTs.push(m.ts);
          }
          await record(
            "decay_applied",
            {
              days,
              retired: retiredTs.length,
              mem: retiredTs.join(",") || "-",
              snapshot: snapshot.join(",") || "-",
            },
            false,
          );
          return {
            content:
              `Decayed ${retiredTs.length} open thread(s) older than ${days} days ` +
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
        async execute(): Promise<{ content: string }> {
          // In-process truth: the live epoch + ledger, fresher than any file.
          const sid = getCurrent().sid;
          const status = sid === "?" ? null : await buildPayload(sid);
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

    // Per-session frozen injection epochs: the relevance block plus the store
    // fingerprint it was computed against. Recomputed on the first prompt of a
    // tracked session, when injectable rows change, or after a compaction (see
    // the prompt/context/compaction hooks) — so the system prefix, and with it
    // the provider prompt cache, survives ordinary requests. The shared LRU
    // below may evict the whole session state; a later prompt starts it fresh.
    const epoch = new Map<
      string,
      { version: string; block: string; at: string; reason: "first" | "store_changed"; refs: MemoryRefs }
    >();
    // Latest user prompt per tracked session. A changed store is re-scored
    // against it even when the change happened during a tool loop with no new
    // prompt. It is evicted together with the epoch and session ledgers.
    const latestPrompt = new Map<string, string>();
    // Recomputes since server start: every one invalidated a prompt cache, so
    // it is the honest cost number the surfaces show (status files / tools).
    let epochRecomputes = 0;

    // Per-session ledger, incremented at the injection decision below, and the
    // last measured prompt-cache usage per session (message.updated). The
    // surfaces read these through flushed status files (TUI) or directly
    // (memory_status, in-process).
    const sessionStats = new Map<string, SessionStats>();
    const measuredTurns = new Map<string, Measured>();
    // Every map above is keyed by session and dropped together on eviction.
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
    const injectableRows = async (): Promise<Memory[]> =>
      (await loadAll()).filter((m) => isActive(m) && isVisibleHere(m));
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
    const refreshEpoch = async (sid: string, rows?: Memory[]): Promise<void> => {
      if (!latestPrompt.has(sid)) return;
      const mems = rows ?? await injectableRows();
      const version = await storeVersion(mems);
      const cached = epoch.get(sid);
      if (cached?.version === version) return;
      const prompt = latestPrompt.get(sid) ?? "";
      const sel = await selectRelevant(prompt, 5, mems, await useSignals()); // widen candidate pool
      const block = sel.block ? capToBudget(sel.block, budget) : "";
      // Refs the ACTUALLY-injected rows assert (paths + commands), the join key
      // for attribution. Derived from the budget-surviving rows, not the wider
      // candidate pool — crediting paths the model never saw would overclaim.
      const rode = injectedRows(block, sel.selected);
      const refs = deriveMemoryRefs(rode);
      // Use ledger (#42): the rows that actually rode the block, credited with
      // the terms the prompt and those rows shared (never the prompt itself).
      await noteHits("inject", sid, rode, prompt);
      const at = new Date().toISOString();
      const reason: "first" | "store_changed" = cached ? "store_changed" : "first";
      epoch.set(sid, { version, block, at, reason, refs });
      await record(
        "epoch_recompute",
        {
          session: sid,
          reason,
          chars: block.length,
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

    // ---- hooks (all fail-closed) -------------------------------------------
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
        // Route store reads in this hook through the right session's scope.
        setCurrent({ sessionID: event?.sessionID });
        const sid = event?.sessionID;
        if (typeof sid === "string") sessions.touch(sid);
        const mems = await injectableRows();
        if (typeof sid === "string") await refreshEpoch(sid, mems);
        const parts: string[] = [];
        await systemDigest(
          { sessionID: event?.sessionID },
          { system: parts },
          { rows: mems, frontierBudget: openBudget },
        );
        for (const text of parts) event?.system?.push?.({ type: "text", text });
        // Deliver this epoch's relevance-ranked memory via the system channel.
        // The UI never renders system parts, unlike appended prompt text.
        const knowledge = typeof sid === "string" ? epoch.get(sid)?.block : undefined;
        if (knowledge) event?.system?.push?.({ type: "text", text: knowledge });
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
          latestPrompt.set(sid, event?.prompt?.text ?? "");
          await refreshEpoch(sid);
        }
      }),
    );

    // Session-convergence rollup at compaction. The epoch is dropped so the
    // next prompt re-scores against the post-compaction store. Memory-aware
    // compaction: the durable-memory anchor is pushed onto the hook's system
    // parts (visible to the summarizer model, which runs AFTER hooks) so the
    // summary preserves the facts. Never sets event.result — that would skip
    // the summarizer call entirely.
    await ctx.session?.hook("compaction", (event: any) =>
      guarded("session.compaction (onCompacting)", async () => {
        setCurrent({ sessionID: event?.sessionID });
        await onCompacting({ sessionID: event?.sessionID });
        if (typeof event?.sessionID === "string") {
          epoch.delete(event.sessionID);
          latestPrompt.delete(event.sessionID);
        }
        const anchor = await compactionAnchor();
        if (anchor) event?.system?.push?.({ type: "text", text: anchor });
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
            const ev = raw as Record<string, any>;
            // Session identity: created fires for new sessions, execution.started
            // every turn (covers sessions resumed across a restart), moved on a
            // workspace change. Stamps and visibility resolve through this.
            if (
              ev?.type === "session.created" ||
              ev?.type === "session.execution.started" ||
              ev?.type === "session.moved"
            ) {
              const d = ev.data ?? ev.properties ?? {};
              const info = d.info ?? d;
              const sid = info.sessionID ?? d.sessionID;
              const dir =
                info.location?.directory ?? d.location?.directory ?? ev.location?.directory ?? info.directory;
              if (typeof sid === "string" && typeof dir === "string") rememberSessionDir(sid, dir);
              // 2.1.4 serve sends execution.started with no location at all:
              // resolve the session row instead of leaving the session unbound.
              else if (typeof sid === "string") void guarded("session bind (api)", () => bindSessionFromApi(sid));
              continue;
            }
            // Token usage: v2 hosts (>=2.0.x) emit `session.usage.updated` with
            // data.{sessionID, tokens}; older hosts carried the same TokenUsage
            // on message.updated's assistant info. Accept both so `measured`
            // populates regardless of host version.
            let usid: unknown;
            let ut: { input?: number; cache?: { read?: number; write?: number } } | undefined;
            if (ev?.type === "session.usage.updated") {
              usid = ev.data?.sessionID;
              ut = ev.data?.tokens;
            } else if (ev?.type === "message.updated") {
              const info = ev.properties?.info ?? ev.info ?? ev.data?.info;
              if (info && info.role === "assistant") {
                usid = info.sessionID;
                ut = info.tokens;
              }
            } else {
              continue;
            }
            if (typeof usid !== "string" || !ut) continue;
            sessions.touch(usid);
            measuredTurns.set(usid, {
              at: new Date().toISOString(),
              input: Number(ut.input) || 0,
              read: Number(ut.cache?.read) || 0,
              write: Number(ut.cache?.write) || 0,
            });
            await guarded("status flush (measured)", () => flushStatus(usid));
          }
        } catch {
          // the subscription ended (abort or host error); nothing to do
        }
      })();
    }

    // ---- opt-in auto-capture on session idle --------------------------------
    // Default OFF: capture never reads sessions and never calls a model. (The
    // measured-cache listener above does subscribe to the event stream by
    // default, but it is zero-model: pure bookkeeping of message usage.) When
    // enabled (options.autoCapture === true AND a valid captureModel), each
    // session.idle event runs ONE cheap ctx.generate.text call whose reply is
    // parsed into candidates that go through the SAME runWriteGate as
    // model-authored writes — capture can never bypass the moat, and it only
    // ever writes through the gate. A per-session cooldown bounds the cost.
    // Every failure inside the loop is swallowed: capture must never be able
    // to break a session.
    let captureCleanup: Cleanup | undefined;
    if (ctx.options?.autoCapture === true) {
      const captureModel =
        typeof ctx.options.captureModel === "string" ? ctx.options.captureModel : "";
      const captureMax = Number(ctx.options.captureMax) || 3;
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
        const lastRun = new Map<string, number>();
        const eventApi = ctx.event;
        const generateApi = ctx.generate;
        // Arrow wrapper: keep the receiver bound. The harness fakes are closures,
        // but a real client method that reads `this` would break if detached —
        // and the fail-closed catch below would hide it. Optional call: the
        // setup guard proves it exists, but property narrowing does not survive
        // into the closure, and undefined degrades safely (empty transcript).
        const contextFn = (input: { sessionID: string }) => ctx.session?.context?.(input);
        void (async () => {
          try {
            for await (const raw of eventApi.subscribe({ signal: controller.signal })) {
              const event = raw as Record<string, any>;
              if (event?.type !== "session.idle") continue;
              const sid = event.sessionID ?? event.properties?.sessionID ?? event.data?.sessionID;
              if (typeof sid !== "string") continue;
              // Bind the idle session so captures stamp (and gate against)
              // that session's repo, not whatever tool call ran last.
              setCurrent({ sessionID: sid });
              const now = Date.now();
              if (now - (lastRun.get(sid) ?? 0) < 5 * 60_000) continue; // 5-min cooldown
              lastRun.set(sid, now);
              try {
                const msgs = await contextFn({ sessionID: sid });
                const transcript = flattenTranscript(msgs);
                if (transcript.length < 200) continue; // too thin to mine reliably
                // #44: how stale is a capture? Distance from the last message of
                // the transcript to this instant. Sessions idle for an hour
                // produce an hour-old capture, and the surfaces now say so.
                const lagMs = lagSince(msgs);
                const out = await generateApi.text({
                  model: modelRef,
                  prompt: buildCapturePrompt(transcript.slice(-8000), captureMax),
                });
                const text = typeof out === "string" ? out : out?.text ?? "";
                const candidates = parseCandidates(text, captureMax);
                for (const c of candidates) {
                  const outcome = await runWriteGate(
                    { ...c, tags: ["auto-capture"] },
                    gateContext(),
                  );
                  await record(
                    `auto_capture_${outcome.action}`,
                    // A blocked credential-shaped scope must not reach the evidence log either.
                    { session: sid, type: c.type, scope: redactSecrets(c.scope), reason: outcome.reason ?? "" },
                    false,
                  );
                }
                await recordCaptureLag(sid, lagMs, candidates.length ? "candidates" : "empty");
              } catch {
                // fail-closed: a broken capture attempt is invisible to the session
              }
            }
          } catch {
            // the subscription itself ended (abort or host error); nothing to do
          }
        })();
        captureCleanup = () => controller.abort();
      }
    }
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
