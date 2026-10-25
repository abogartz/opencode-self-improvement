// Consolidation proposals (#45): episodic rows → one canonical row, proposed and
// measured, never silently applied.
//
// The write-gate already collapses byte-identical restatements and flags >0.9
// jaccard overlaps *at write time*. What it cannot do is notice the slow drift
// that only a store develops later: three settled rows in one scope, written
// weeks apart, saying nearly the same thing in slightly different words. Every
// one of them rides the budget, and each is reachable by a different fragment
// of vocabulary.
//
// The literature is blunt that this step is where memory systems break (arXiv
// 2603.07670: "rarely automatic… fragile and hard to validate"), and NOOA's
// published numbers are the reason this file refuses to be clever: their
// reflection records were 22% of rows but ~1% of reads, and abstracting hurt
// pinpoint lookup. So the rules here are:
//
//   1. DETERMINISTIC MERGE. The canonical row is the survivor's prose, verbatim,
//      plus the aliases and distinctive vocabulary of the rows it absorbs. No
//      model rewrites anything — a rewrite cannot be diffed, audited, or proven
//      to preserve meaning, and this plugin ships no model.
//   2. PROVEN READS, per cluster. Every read the cluster has actually served is
//      taken from the use ledger and replayed against the merged store. A merge
//      is proposed only when the merged row catches at least as many of those
//      reads as the best single member did. "Looks redundant" is not a reason.
//   3. PROPOSALS, not writes. Nothing here mutates the store. A human resolves a
//      proposal through memory_merge_review (supersede-not-delete, recoverable).
//   4. The most recently used member is never a loser (#42's rule, inherited).
import type { Memory } from "./memory.ts";
import type { UseSignal } from "./hits.ts";
import { cmpTs, formatMemory, scoreMemories, words } from "./inject.ts";

/** Default jaccard floor for "these two rows are the same statement". */
export const DEFAULT_JACCARD = 0.55;
/** Aliases are useful up to a point; a merged row that hoards 60 words is noise. */
export const MAX_MERGED_KW = 12;

export interface ReadSet {
  /** The terms a real read used, exactly as the ledger recorded them. */
  terms: string[];
  /** Row ids that read credited. */
  rows: string[];
}

export interface ClusterOptions {
  jaccard?: number;
  /** Smallest cluster worth proposing (2 = a pair). */
  minMembers?: number;
  /** Ceiling on cluster size: 6 rows merged is a rewrite, not a merge. */
  maxMembers?: number;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_.]+/).filter(Boolean);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Candidate clusters of settled, same-scope, same-type rows that say the same
 * thing. Grouping is transitive on the jaccard edge (union-find), so a chain of
 * "almost the same" rows becomes one cluster instead of N/2 arbitrary pairs.
 *
 * Open rows are excluded on purpose: an open thread is a live plan, not episodic
 * material to compress, and collapsing it would destroy the frontier the panel
 * is showing the user.
 */
export function clustersFor(rows: Memory[], opts: ClusterOptions = {}): Memory[][] {
  const min = opts.jaccard ?? DEFAULT_JACCARD;
  const minMembers = opts.minMembers ?? 2;
  const maxMembers = opts.maxMembers ?? 6;
  const pool = rows
    .filter((m) => !m.superseded_by && m.status !== "open" && m.content.trim())
    .sort((a, b) => cmpTs(a.ts, b.ts));

  const parent = pool.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const toks = pool.map((m) => new Set(tokens(m.content)));
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i]!;
      const b = pool[j]!;
      if (a.scope !== b.scope || a.type !== b.type) continue;
      if (jaccard(toks[i]!, toks[j]!) >= min) union(i, j);
    }
  }

  const groups = new Map<number, Memory[]>();
  pool.forEach((m, i) => {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(m);
    groups.set(root, g);
  });
  return [...groups.values()]
    .filter((g) => g.length >= minMembers && g.length <= maxMembers)
    .sort((a, b) => cmpTs(a[0]!.ts, b[0]!.ts));
}

/**
 * The canonical row of a cluster: the most recently used member, falling back to
 * the newest row when the ledger knows nothing. Recency in the boost is not
 * recency in the ledger — a row that retrieval has actually been landing on is
 * the one worth keeping, and this is #42's rule applied to merges.
 */
export function survivorFor(cluster: Memory[], use?: Map<string, UseSignal>): Memory {
  return [...cluster].sort((a, b) => {
    const la = use?.get(a.ts)?.last ?? "";
    const lb = use?.get(b.ts)?.last ?? "";
    if (la !== lb) return la < lb ? 1 : -1;
    return cmpTs(b.ts, a.ts);
  })[0]!;
}

export interface MergePlan {
  id: string;
  scope: string;
  type: string;
  survivor: Memory;
  losers: Memory[];
  /** What the canonical row would look like. */
  merged: Memory;
  /** Reads the cluster served, taken from the ledger. */
  reads: ReadSet[];
  readsBefore: number;
  readsAfter: number;
  bestMemberBefore: number;
  bytesBefore: number;
  bytesAfter: number;
  accepted: boolean;
  reasons: string[];
}

/** Distinctive vocabulary of the absorbed rows: what the survivor does not say. */
function inheritedKw(cluster: Memory[], survivor: Memory): string[] {
  const have = new Set(words(`${survivor.content} ${(survivor.kw ?? []).join(" ")}`));
  const out = [...(survivor.kw ?? [])];
  for (const m of cluster) {
    if (m.ts === survivor.ts) continue;
    for (const k of m.kw ?? []) if (!out.includes(k)) out.push(k);
    // Only distinctive words the absorbed row was FOUND by, in practice: its
    // own vocabulary minus what the survivor already carries.
    for (const w of words(m.content)) {
      if (!have.has(w) && !out.includes(w)) out.push(w);
    }
  }
  return out.slice(0, MAX_MERGED_KW);
}

function buildMerged(cluster: Memory[], survivor: Memory): Memory {
  const kw = inheritedKw(cluster, survivor);
  return {
    ...survivor,
    kw: kw.length ? kw : undefined,
    tags: [...new Set(["consolidated", ...(survivor.tags ?? []), ...cluster.flatMap((m) => m.tags ?? [])])].slice(
      0,
      12,
    ),
  };
}

/**
 * Replay the cluster's real reads against a store where the cluster has been
 * replaced by the merged row. `rows` is the whole active store; the function
 * returns how many of those reads still land on the cluster.
 */
// Cluster bookkeeping uses OBJECT identity, not `ts`. The ledger keys on ts
// (correctly — it is the row id in the store), but nothing here may assume two
// rows cannot share one timestamp: the eval store does exactly that, and a
// ts-keyed filter would silently absorb an entire cluster into its survivor.
function replayReads(rows: Memory[], cluster: Memory[], replacement: Memory | null, reads: ReadSet[]): number {
  const inCluster = new Set(cluster);
  const store = replacement ? [...rows.filter((m) => !inCluster.has(m)), replacement] : rows;
  let hits = 0;
  for (const r of reads) {
    const query = r.terms.join(" ");
    if (!query.trim()) continue;
    const top = scoreMemories(query, store, 3);
    const landed = top.some((m) => (replacement ? m === replacement : inCluster.has(m)));
    if (landed) hits++;
  }
  return hits;
}

/** Reads the ledger says this cluster served (any member credited). */
export function readsFor(cluster: Memory[], allReads: ReadSet[]): ReadSet[] {
  const ids = new Set(cluster.map((m) => m.ts));
  return allReads.filter((r) => r.rows.some((id) => ids.has(id)) && r.terms.length > 0);
}

/**
 * One cluster → one measured proposal. `rows` is the full active store; `use`
 * and `reads` come from the use ledger. A cluster with no recorded reads is
 * reported as unmeasurable rather than merged on vibes.
 */
export function proposeCluster(
  rows: Memory[],
  cluster: Memory[],
  use: Map<string, UseSignal>,
  allReads: ReadSet[],
): MergePlan {
  const survivor = survivorFor(cluster, use);
  const losers = cluster.filter((m) => m !== survivor);
  const merged = buildMerged(cluster, survivor);
  const reads = readsFor(cluster, allReads);

  // The bar the ticket sets: the merged row must catch at least as many of the
  // cluster's own reads as the BEST single member did on its own.
  const members = cluster.map((m) => replayReads(rows, cluster, m, reads));
  const bestMemberBefore = members.length ? Math.max(...members) : 0;
  const readsBefore = replayReads(rows, cluster, null, reads);
  const readsAfter = replayReads(rows, cluster, merged, reads);

  const bytesBefore = cluster.reduce((n, m) => n + formatMemory(m).length, 0);
  const bytesAfter = formatMemory(merged).length;

  const reasons: string[] = [];
  if (!reads.length) reasons.push("unmeasured: the ledger has no read for any member of this cluster");
  else if (readsAfter < bestMemberBefore)
    reasons.push(
      `reads would drop: merged row catches ${readsAfter} of ${reads.length}, the best member alone caught ${bestMemberBefore}`,
    );
  if (bytesAfter > bytesBefore) reasons.push("merged row is larger than the rows it absorbs");

  return {
    id: `cl-${cluster
      .map((m) => m.ts)
      .sort()[0]!
      .replace(/[^0-9]/g, "")
      .slice(-9)}`,
    scope: survivor.scope,
    type: survivor.type,
    survivor,
    losers,
    merged,
    reads,
    readsBefore,
    readsAfter,
    bestMemberBefore,
    bytesBefore,
    bytesAfter,
    accepted: reasons.length === 0,
    reasons,
  };
}

export interface ProposalReport {
  plans: MergePlan[];
  rowsBefore: number;
  rowsAfter: number;
  injectedBefore: number;
  injectedAfter: number;
}

/**
 * The pass: cluster, measure, keep only proposals that prove the reads survive.
 * Dry by construction — the caller decides whether anything is applied.
 */
export function proposeConsolidations(
  rows: Memory[],
  use: Map<string, UseSignal>,
  reads: ReadSet[],
  opts: ClusterOptions = {},
): ProposalReport {
  const plans = clustersFor(rows, opts)
    .map((c) => proposeCluster(rows, c, use, reads))
    .filter((p) => p.accepted);
  const absorbed = new Set<Memory>(plans.flatMap((p) => p.losers));
  const injected = (list: Memory[]) => list.reduce((n, m) => n + formatMemory(m).length, 0);
  return {
    plans,
    rowsBefore: rows.length,
    rowsAfter: rows.length - absorbed.size,
    injectedBefore: injected(rows),
    // Absorbed rows leave the budget; canonical rows keep theirs (kw never renders).
    injectedAfter: injected(rows.filter((m) => !absorbed.has(m))),
  };
}

/** Human-readable proposal list. Ends with the exact command to resolve one. */
export function renderProposals(report: ProposalReport): string {
  const out: string[] = ["CONSOLIDATION PROPOSALS — nothing was written", ""];
  if (!report.plans.length) {
    out.push("  none — no cluster proved it could hold its reads.");
    return out.join("\n");
  }
  for (const p of report.plans) {
    out.push(
      `${p.id}  ${p.type}/${p.scope}  ${p.losers.length + 1} rows → 1`,
      `  keep   ${p.survivor.ts}`,
      `    ${p.survivor.content.slice(0, 160)}`,
      ...p.losers.map((l) => `  absorb ${l.ts}  ${l.content.slice(0, 120)}`),
      `  reads  ${p.reads.length} logged · best member alone ${p.bestMemberBefore} · merged ${p.readsAfter}`,
      `  budget ${p.bytesBefore}c → ${p.bytesAfter}c for this cluster`,
      `  resolve: memory_merge_review(loser="${p.losers[0]!.ts}", survivor="${p.survivor.ts}", reason="consolidate ${p.id}")`,
      "",
    );
  }
  out.push(
    `STORE  ${report.rowsBefore} rows → ${report.rowsAfter} if every proposal is resolved · ` +
      `injected ${report.injectedBefore}c → ${report.injectedAfter}c`,
  );
  out.push("Resolving is supersede-not-delete: absorbed rows stay recoverable via memory_undo.");
  return out.join("\n");
}
