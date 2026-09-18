// The 4-gate write pipeline: GATE-1
// canonical-graph correctness, GATE-2 stale-ref scan + supersession, GATE-3
// dedup, GATE-4 promotion/block. Every step emits an ordered evidence line.
import { join } from "node:path";
import { memoryRoot, canonicalFile } from "./config.ts";
import { bracketList, parseLine, readLines } from "./logfmt.ts";
import {
  appendMemory,
  loadAll,
  loadScope,
  markSuperseded,
  snapshotFiles,
  type Memory,
} from "./memory.ts";
import { chainId, contentHash, record, recordWriteBlocked } from "./evidence.ts";
import {
  displayCall,
  extractCallForms,
  findLiveCall,
  gate1,
  sameArgs,
  type DriftInfo,
} from "./resolver.ts";

export interface WriteCandidate {
  type: string;
  scope: string;
  content: string;
  issue?: string;
  tags?: string[];
  status?: "open" | "settled";
}

export interface GateContext {
  liveRoot: string;
  evidenceCalls: string[];
  hasGateCheck: boolean;
  // True when the session exercised the code (read/grep/edit/bash results
  // recorded). Empirical engagement substitutes for hand-copied refs (gate
  // injection): the write encodes behavior that actually happened here, so the
  // formal gate check is not the only admissible grounding.
  hasEngagement?: boolean;
  // Plugin-authored bookkeeping (e.g. init stamps, script memories) bypasses
  // the GATE-4 ambiguity rule: it embeds no refs and has no completion-gate
  // evidence by construction, but is still evaluated by GATE-1/2/3.
  trusted?: boolean;
}

export interface GateOutcome {
  action: "promoted" | "blocked" | "collapsed";
  reason?: string;
  ts?: string;
  chain: string;
  hint?: string;
}

const STOPWORDS = new Set([
  "use",
  "using",
  "the",
  "a",
  "an",
  "in",
  "of",
  "to",
  "with",
  "on",
  "and",
  "or",
  "for",
  "is",
  "are",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .filter((t) => t.length > 0);
}

// Case-preserving tokens, for reporting asserted values back to the user.
function rawTokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9_.]+/).filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Planning-flavored content (frontier/thread/proposal language). Used only to
// turn GATE-4's ambiguous block into a hint pointing at the open-thread home.
const PLANNING_WORDS = new Set([
  "plan", "plans", "planned", "planning", "frontier", "propos", "proposal",
  "open", "goal", "goals", "decide", "decides", "decided", "deciding",
  "reject", "rejects", "rejected", "thread", "should", "option", "options",
  "candidate", "candidates", "next", "roadmap", "scale", "overhead", "bloat",
]);

function looksPlanning(candidate: WriteCandidate): boolean {
  return tokens(candidate.content).some((t) => PLANNING_WORDS.has(t));
}

interface CanonEntry {
  ts: string;
  entity: string;
  value: string;
  scope: string;
  source: string;
}

async function loadCanonical(): Promise<CanonEntry[]> {
  const lines = await readLines(canonicalFile());
  const out: CanonEntry[] = [];
  for (const line of lines) {
    const f = parseLine(line);
    if (!f || f.type !== "canonical") continue;
    if (typeof f.entity !== "string" || typeof f.value !== "string") continue;
    out.push({
      ts: typeof f.ts === "string" ? f.ts : "?",
      entity: f.entity,
      value: f.value,
      scope: typeof f.scope === "string" ? f.scope : "",
      source: typeof f.source === "string" ? f.source : "?",
    });
  }
  return out;
}

function canonicalMatch(
  scope: string,
  content: string,
  registry: CanonEntry[],
): { entry: CanonEntry; aligns: boolean; conflictingValue?: string } | null {
  const ct = tokens(content);
  for (const entry of registry) {
    if (entry.scope !== scope) continue;
    const et = tokens(entry.entity);
    if (!et.length || !et.every((t) => ct.includes(t))) continue;
    const aligns = tokens(entry.value).every((t) => ct.includes(t));
    let conflictingValue: string | undefined;
    if (!aligns) {
      const entitySet = new Set(et);
      const asserted = rawTokens(content).filter(
        (t) => !STOPWORDS.has(t.toLowerCase()) && !entitySet.has(t.toLowerCase()),
      );
      conflictingValue = asserted[0];
    }
    return { entry, aligns, conflictingValue };
  }
  return null;
}

interface StaleRef {
  memory: Memory;
  symbol: string;
  from: string;
  to: string;
}

async function staleRefFor(m: Memory, liveRoot: string): Promise<StaleRef | null> {
  for (const form of extractCallForms(m.content)) {
    const live = await findLiveCall(form.name, form.fileHint, liveRoot);
    if (!live) continue;
    if (!sameArgs(form.argsText, live.argsText)) {
      return {
        memory: m,
        symbol: form.symbol,
        from: displayCall(form.name, form.argsText),
        to: displayCall(form.name, live.argsText),
      };
    }
  }
  return null;
}

function deltaTokens(candidate: WriteCandidate, drift: DriftInfo | null): string[] {
  const set = new Set<string>();
  for (const form of extractCallForms(candidate.content)) {
    if (form.fileHint) set.add(form.fileHint);
  }
  if (drift) {
    const owner = drift.symbol.split(".").slice(0, -1).pop();
    if (owner) set.add(owner);
  }
  return [...set];
}

export async function runWriteGate(
  candidate: WriteCandidate,
  ctx: GateContext,
): Promise<GateOutcome> {
  const chain = chainId();
  const ch = contentHash(candidate.content);
  await record("gate_start", {
    chain,
    op: "write",
    scope: candidate.scope,
    type: candidate.type,
    ch,
  });

  const scopeMems = candidate.scope ? await loadScope(candidate.scope) : [];

  // ---- GATE-1: canonical graph correct ------------------------------------
  const g1 = await gate1({
    content: candidate.content,
    scope: candidate.scope,
    liveRoot: ctx.liveRoot,
    scopeMemories: scopeMems,
  });
  if (g1.drift) {
    await record("graph_drift", {
      gate: 1,
      symbol: g1.drift.symbol,
      from: g1.drift.from,
      to: g1.drift.to,
      corrected: true,
      evidence: ctx.evidenceCalls[0] ?? "-",
      chain,
    });
  } else {
    await record("graph_current", {
      gate: 1,
      refs: g1.refs,
      resolved: g1.resolved.length ? g1.resolved.join(",") : undefined,
      chain,
    });
  }

  // Canonical registry is consulted at GATE-2 but needed for block decisions.
  const registry = await loadCanonical();
  const canon = candidate.scope
    ? canonicalMatch(candidate.scope, candidate.content, registry)
    : null;

  // ---- GATE-2: no stale memories apply here -------------------------------
  const delta = deltaTokens(candidate, g1.drift);
  const stale: StaleRef[] = [];
  for (const m of scopeMems) {
    const s = await staleRefFor(m, ctx.liveRoot);
    if (s) stale.push(s);
  }
  const bailed = scopeMems.length === 0;
  await record("ref_stale_scan", {
    gate: 2,
    scope: candidate.scope,
    delta: bracketList(delta),
    scanned: scopeMems.length,
    found: stale.length,
    bailed,
    chain,
  });

  let supersededTs: string | undefined;
  for (const s of stale) {
    await record("ref_stale", {
      gate: 2,
      mem: s.memory.ts,
      scope: candidate.scope,
      ref: s.symbol,
      from: s.from,
      to: s.to,
      chain,
    });
    // Drift-fed supersession is AUTO (provable) and target depends on whether a
    // valid write will land; stale data is neutralized either way.
    const target = g1.candidateStale ? "<-" : chain;
    const marked = await markSuperseded(s.memory.ts, {
      superseded_by: target,
      reason: "drift",
      symbol: s.symbol,
      from: s.from,
      to: s.to,
    });
    if (marked) {
      supersededTs = s.memory.ts;
      await record("superseded_by", {
        gate: 2,
        mem: s.memory.ts,
        target,
        reason: "drift",
        symbol: s.symbol,
        from: s.from,
        to: s.to,
        chain,
      });
    }
  }

  if (canon) {
    await record("canonical_hit", {
      gate: 2,
      entity: canon.entry.entity,
      value: canon.entry.value,
      scope: canon.entry.scope,
      source: canon.entry.source,
      chain,
    });
    // Any in-scope entry that contradicts the canonical value is neutralized.
    const entitySet = new Set(tokens(canon.entry.entity));
    const valueSet = new Set(tokens(canon.entry.value));
    for (const m of scopeMems) {
      if (m.superseded_by) continue;
      if (tokens(m.content).some((t) => valueSet.has(t))) continue;
      const from = rawTokens(m.content).find(
        (t) => !STOPWORDS.has(t.toLowerCase()) && !entitySet.has(t.toLowerCase()) && !valueSet.has(t.toLowerCase()),
      );
      const target = canon.aligns ? chain : "<-";
      const marked = await markSuperseded(m.ts, {
        superseded_by: target,
        reason: "canonical",
        entity: canon.entry.entity,
        from: from ?? undefined,
        to: canon.entry.value,
      });
      if (marked) {
        if (!supersededTs) supersededTs = m.ts;
        await record("superseded_by", {
          gate: 2,
          mem: m.ts,
          target,
          reason: "canonical",
          entity: canon.entry.entity,
          from: from ?? undefined,
          to: canon.entry.value,
          chain,
        });
      }
    }
  }

  // ---- GATE-3: no dupes ----------------------------------------------------
  const conflictProne = candidate.type === "decision" || candidate.type === "preference";
  const active = scopeMems.filter((m) => !m.superseded_by);
  // Exact duplicates are detected against the full scope (a drift-superseded
  // twin still collapses), but overlap/merge only considers live entries.
  const exactPoll = scopeMems.filter(
    (m) => m.superseded_by === undefined || m.reason === "drift",
  );
  const exact = exactPoll.find(
    (m) => m.type === candidate.type && m.content === candidate.content,
  );
  const divergent = active.filter(
    (m) => m.type === candidate.type && m.content !== candidate.content,
  );

  let collapseMatch: Memory | undefined;
  let overlapMatch: Memory | undefined;
  let overlapScore = 0;

  if (
    exact &&
    !exact.superseded_by &&
    (canon?.aligns || !(conflictProne && divergent.length))
  ) {
    // Byte-identical duplicate collapses (Principle 2) — exactness is
    // independent of the canonical registry, so a decided/preferred fact
    // restated verbatim is never "conflicting" content on its own. Two
    // exceptions keep the S4/S4b semantics: a canonical that aligns resolves
    // the rivalry (echo collapses), but a scope already holding RIVAL
    // decision/preference entries with no resolving canon keeps the exact
    // restatement review-gated — dedup must not silently bury a conflict.
    collapseMatch = exact;
  } else if (conflictProne) {
    if (!canon && divergent.length) {
      // Conflicting decisions without a registry entry -> review-gated merge.
      overlapMatch = divergent[0];
      overlapScore =
        Math.round(jaccard(tokens(candidate.content), tokens(divergent[0].content)) * 100) / 100;
    }
  } else {
    let best: { m: Memory; score: number } | undefined;
    for (const m of active) {
      if (m.type !== candidate.type) continue;
      const score = jaccard(tokens(candidate.content), tokens(m.content));
      if (score >= 0.9 && (!best || score > best.score)) best = { m, score };
    }
    if (best) {
      overlapMatch = best.m;
      overlapScore = Math.round(best.score * 100) / 100;
    }
  }

  if (collapseMatch) {
    await record("dedup_collapse", {
      gate: 3,
      survivors: scopeMems.length,
      match: collapseMatch.ts,
      ch,
      action: "canonical_existing",
      incoming_ignored: true,
      chain,
    });
  } else if (overlapMatch) {
    await record("dedup_overlap", {
      gate: 3,
      survivors: scopeMems.length,
      candidate: overlapMatch.ts,
      score: overlapScore,
      action: "propose_merge",
      chain,
    });
  } else {
    await record("dedup_clean", {
      gate: 3,
      survivors: scopeMems.length,
      candidate: 0,
      chain,
    });
  }

  // ---- GATE-4: write or block ---------------------------------------------
  const flags: string[] = [];
  if (candidate.scope === "") flags.push("empty_scope");
  if (g1.refs === 0) flags.push("no_embedded_refs");
  if (!ctx.hasGateCheck) flags.push("no_evidence_refs");
  // A canonical-registry hit is itself authority, so it lifts the ambiguity
  // rule (S4b-i promotes with no embedded refs and no completion-gate call).
  // An explicit status="open" is the planning-object home: those entries are
  // provisional by definition (not claims about code), so only a missing scope
  // keeps them ambiguous. Empirical engagement (a completion-gate run, or any
  // read/grep/edit/run of the code in-session) grounds settled claims too:
  // the write is the residue of behavior that actually happened here, so
  // hand-copied refs are redundant (gate injection).
  const planningObject = candidate.status === "open";
  const behaviorGrounded = ctx.hasGateCheck || ctx.hasEngagement === true;
  const ambiguous =
    !ctx.trusted && !canon &&
    (candidate.scope === "" || (!planningObject && g1.refs === 0 && !behaviorGrounded));

  let blockReason: string | undefined;
  let blockFlags: string[] = [];
  let hint: string | undefined;
  if (g1.candidateStale) {
    blockReason = "drift_ref_stale_incoming";
    blockFlags = ["incoming_embeds_pre_drift_ref"];
  } else if (canon && !canon.aligns) {
    blockReason = "conflicts_with_canonical";
    blockFlags = [
      `canonical=${canon.entry.value}`,
      `incoming=${canon.conflictingValue ?? "?"}`,
    ];
  } else if (overlapMatch) {
    blockReason = "superseded_overlap";
    const newest = scopeMems[scopeMems.length - 1];
    blockFlags = [`supersedes_check_${newest ? newest.ts : "-"}`, "review_gated"];
  } else if (ambiguous && !collapseMatch) {
    blockReason = "ambiguous_memory";
    blockFlags = flags;
    if (looksPlanning(candidate)) {
      hint =
        'Looks like an open planning thread. Retry with status="open" and a non-empty scope to store it as a frontier item, or run the completion gates to ground it.';
    }
  }

  if (blockReason) {
    await recordWriteBlocked(4, blockReason, blockFlags, chain);
    if (blockReason === "superseded_overlap" && overlapMatch) {
      const newest = scopeMems[scopeMems.length - 1] ?? overlapMatch;
      await record("merge_proposal", {
        candidate: overlapMatch.ts,
        incoming: chain,
        canonical: newest.ts,
        source: `durable_${candidate.type}`,
        review: "required",
        chain,
      });
    }
    return { action: "blocked", reason: blockReason, chain, hint };
  }

  if (collapseMatch) {
    return { action: "collapsed", chain };
  }

  // The write is specifically promoted on engagement (no refs, no gate check,
  // not canonical, not an open object). Emitted so the precedent is auditable.
  const groundedByEngagement =
    !ctx.trusted && !canon && !planningObject &&
    g1.refs === 0 && !ctx.hasGateCheck &&
    ctx.hasEngagement === true && candidate.scope !== "";
  if (groundedByEngagement) {
    await record("gate_injected", { gate: 4, chain });
  }

  const snapshot = await snapshotFiles([join(memoryRoot(), `${new Date().toISOString().split("T")[0]}.logfmt`)]);
  const ts = await appendMemory(candidate);
  await record("write_promoted", {
    gate: 4,
    op: "write",
    mem: ts,
    scope: candidate.scope,
    type: candidate.type,
    status: candidate.status ?? "settled",
    ch,
    supersedes: supersededTs ?? "-",
    canonical: canon ? `canonical.logfmt:${canon.entry.ts}` : "-",
    evidence_refs: bracketList(ctx.evidenceCalls),
    snapshot: snapshot[0] ?? "-",
    trusted: ctx.trusted ? true : undefined,
    grounded_by: groundedByEngagement ? "engagement" : undefined,
    chain,
  });
  return { action: "promoted", ts, chain };
}
