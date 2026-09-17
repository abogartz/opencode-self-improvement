// opencode-self-improvement: one opencode plugin bundling durable memory, the
// 4-gate write pipeline (SPEC.md), deterministic reflection triggers T1/T2/T4,
// tiny-digest injection with contextual pull, and snapshot/rollback.
import { join } from "node:path";
import { type Plugin, tool } from "@opencode-ai/plugin";
import { evidenceDir, memoryRoot, dateStr } from "./config.ts";
import { loadAll, isActive, markSuperseded, type Memory } from "./memory.ts";
import { runWriteGate, type GateContext, type WriteCandidate } from "./gates.ts";
import { pruneMemory } from "./prune.ts";
import { listSnapshots, restoreSnapshot } from "./undo.ts";
import { contextualPull, formatMemory, systemDigest } from "./inject.ts";
import { formatInit, runInit } from "./init.ts";
import { ensureInitCommand } from "./command.ts";
import { afterTool, evidenceCalls, hasGateCheck, onCompacting } from "./triggers.ts";
import { getCurrent, setCurrent } from "./state.ts";
import { readLines } from "./logfmt.ts";

const TYPES = ["decision", "learning", "preference", "blocker", "context", "pattern"] as const;

function scoreMemory(m: Memory, q: string): number {
  const hay = `${m.type} ${m.scope} ${m.content}`.toLowerCase();
  let score = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (hay.includes(w)) score++;
    if (m.scope.toLowerCase() === w) score += 2;
    if (m.type.toLowerCase() === w) score += 2;
  }
  return score;
}

export const SelfImprovement: Plugin = async (ctx) => {
  const liveRoot = ctx?.directory ?? process.cwd();
  await ensureInitCommand();

  const gateContext = (): GateContext => ({
    liveRoot,
    evidenceCalls: evidenceCalls(getCurrent().sid),
    hasGateCheck: hasGateCheck(getCurrent().sid),
  });

  const remember = tool({
    description:
      "Store a memory after the 4-gate write pipeline validates it (canonical graph, stale refs, dupes). Blocked writes record evidence instead of persisting.",
    args: {
      type: tool.schema.enum(TYPES).describe("Type of memory"),
      scope: tool.schema.string().describe("Scope/area (e.g., auth, api, ctl)"),
      content: tool.schema.string().describe("The memory content"),
      issue: tool.schema.string().optional().describe("Related issue"),
      tags: tool.schema.array(tool.schema.string()).optional(),
    },
    async execute(args) {
      const candidate: WriteCandidate = {
        type: args.type,
        scope: args.scope,
        content: args.content,
        issue: args.issue,
        tags: args.tags,
      };
      const outcome = await runWriteGate(candidate, gateContext());
      if (outcome.action === "promoted") {
        return `Remembered: ${args.type} in ${args.scope}`;
      }
      if (outcome.action === "collapsed") {
        return `Duplicate ignored: ${args.type}/${args.scope}`;
      }
      return `Write blocked at GATE (${outcome.reason}). Evidence recorded for /refine review.`;
    },
  });

  const init = tool({
    description:
      "Initialize repository memory and knowledge graph. Ensures the codebase-memory graph for this repo is indexed (one-shot `cli` spawn; no session MCP needed) and re-derives build/lint/test/typecheck command memories through the write gate, then stores an init stamp keyed on git HEAD. Idempotent: a no-op when the stamp matches HEAD, unless force=true (refresh after a refactor).",
    args: {
      force: tool.schema.boolean().optional().describe("Re-run even if initialized (refresh after drift)"),
      mode: tool.schema
        .enum(["fast", "moderate", "full"])
        .optional()
        .describe("codebase-memory index mode (default moderate)"),
    },
    async execute(args) {
      const summary = await runInit({ liveRoot, force: args.force, mode: args.mode });
      return formatInit(summary);
    },
  });

  const recall = tool({
    description: "Retrieve memories by scope, type, or search query (read path; no gate).",
    args: {
      scope: tool.schema.string().optional(),
      type: tool.schema.enum(TYPES).optional(),
      query: tool.schema.string().optional(),
      limit: tool.schema.number().optional(),
    },
    async execute(args) {
      let results = (await loadAll()).filter(isActive);
      if (!results.length) return "No memories found";
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
      const limited = results.slice(-limit);
      if (!limited.length) return "No matching memories";
      return `Found ${results.length} (${total} total)\n\n${limited.map(formatMemory).join("\n")}`;
    },
  });

  const update = tool({
    description: "Update an existing memory (gated like remember; the prior entry is superseded, not erased).",
    args: {
      scope: tool.schema.string(),
      type: tool.schema.enum(TYPES),
      content: tool.schema.string(),
      query: tool.schema.string().optional(),
    },
    async execute(args) {
      const prior = (await loadAll()).filter(
        (m) => m.scope === args.scope && m.type === args.type && isActive(m),
      );
      const target = prior[prior.length - 1];
      const outcome = await runWriteGate(
        { type: args.type, scope: args.scope, content: args.content },
        gateContext(),
      );
      if (outcome.action === "promoted" && outcome.ts && target) {
        await markSuperseded(target.ts, {
          superseded_by: outcome.ts,
          reason: "update",
        });
        return `Updated ${args.type} in ${args.scope}`;
      }
      if (outcome.action === "promoted") return `Remembered: ${args.type} in ${args.scope}`;
      if (outcome.action === "collapsed") return `Duplicate ignored: ${args.type}/${args.scope}`;
      return `Write blocked at GATE (${outcome.reason}).`;
    },
  });

  const forget = tool({
    description: "Delete memories by scope and type. Snapshots first, logs the reason for audit, never touches a repo.",
    args: {
      scope: tool.schema.string(),
      type: tool.schema.enum(TYPES),
      reason: tool.schema.string().describe("Why this is being deleted (audit)"),
    },
    async execute(args) {
      const res = await pruneMemory(args.scope, args.type, args.reason);
      if (!res.deleted.length) return `No memories found for ${args.type} in ${args.scope}`;
      return `Deleted ${res.deleted.length} ${args.type} memory(s) from ${args.scope}. Audit: ${res.audit}`;
    },
  });

  const list = tool({
    description: "List memory scopes and types for discovery.",
    args: {},
    async execute() {
      const mems = (await loadAll()).filter(isActive);
      if (!mems.length) return "No memories found";
      const scopes = new Map<string, number>();
      const types = new Map<string, number>();
      for (const m of mems) {
        scopes.set(m.scope, (scopes.get(m.scope) ?? 0) + 1);
        types.set(m.type, (types.get(m.type) ?? 0) + 1);
      }
      const fmt = (map: Map<string, number>) =>
        [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `  ${k}: ${c}`).join("\n");
      return `Total: ${mems.length}\n\nScopes:\n${fmt(scopes)}\n\nTypes:\n${fmt(types)}`;
    },
  });

  const undo = tool({
    description: "List memory snapshots, or restore one by name (rollback).",
    args: {
      list: tool.schema.boolean().optional().describe("List snapshots"),
      snapshot: tool.schema.string().optional().describe("Snapshot file to restore"),
    },
    async execute(args) {
      if (args.snapshot) {
        const target = await restoreSnapshot(args.snapshot, memoryRoot());
        return `Restored ${args.snapshot} -> ${target}`;
      }
      const snaps = await listSnapshots();
      if (!snaps.length) return "No snapshots";
      return snaps.map((s) => `${s.name}  (${s.bytes} bytes)`).join("\n");
    },
  });

  const evidence = tool({
    description: "Read captured evidence (data only) for a date, optionally filtered by event.",
    args: {
      date: tool.schema.string().optional(),
      ev: tool.schema.string().optional(),
      limit: tool.schema.number().optional(),
    },
    async execute(args) {
      const file = join(evidenceDir(), `${args.date || dateStr()}.logfmt`);
      let lines = await readLines(file);
      if (args.ev) lines = lines.filter((l) => l.includes(`ev=${args.ev}`));
      if (!lines.length) return "No evidence";
      const limit = args.limit || 50;
      return lines.slice(-limit).join("\n");
    },
  });

  return {
    tool: {
      memory_init: init,
      memory_remember: remember,
      memory_recall: recall,
      memory_update: update,
      memory_forget: forget,
      memory_list: list,
      memory_undo: undo,
      memory_evidence: evidence,
    },
    "tool.execute.before": async (input) => {
      setCurrent(input);
    },
    "tool.execute.after": async (input, output) => {
      setCurrent(input);
      await afterTool(input, output);
      await contextualPull(input, output);
    },
    "experimental.chat.system.transform": async (_input, output) => {
      await systemDigest(_input, output);
    },
    "experimental.session.compacting": async (input) => {
      await onCompacting(input);
    },
  };
};

export default SelfImprovement;
