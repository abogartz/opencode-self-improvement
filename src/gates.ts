// The 4-gate write pipeline: GATE-1
// canonical-graph correctness, GATE-2 stale-ref scan + supersession, GATE-3
// dedup, GATE-4 promotion/block. Every step emits an ordered evidence line.
import { join } from "node:path";
import { memoryRoot, canonicalFile } from "./config.ts";
import { bracketList, parseLine, readLines } from "./logfmt.ts";
import {
  appendMemory,
  loadScope,
  markManySupersededReport,
  snapshotFiles,
  MAX_CONTENT_CHARS,
  type Memory,
  type SupersedeFields,
} from "./memory.ts";
import { chainId, contentHash, record, recordWriteBlocked } from "./evidence.ts";
import { getCurrent, noteAuthored } from "./state.ts";
import { MAX_WRITE_EVIDENCE_REFS } from "./triggers.ts";
import { flattenMemoryText } from "./sanitize.ts";
import { containsSecret, redactSecrets } from "./secrets.ts";
import { readerFromSid, UnresolvedWriterError, type Reader } from "./memory.ts";
import { writeTarget, type WriteTarget } from "./repokey.ts";
import {
  displayCall,
  extractCallForms,
  findLiveCall,
  gate1,
  memoTree,
  sameArgs,
  type DriftInfo,
  type LazyTree,
} from "./resolver.ts";
import { STOPWORDS, jaccard, rawTokens, tokens } from "./tokenize.ts";
import { probeRejection } from "./tombstones.ts";

export interface WriteCandidate {
  type: string;
  scope: string;
  content: string;
  issue?: string;
  tags?: string[];
  // Retrieval keywords (#40) — indexed for recall, never rendered. Normalised
  // (trim/lowercase/cap) at promotion, so a caller may hand junk without
  // changing the verdict the prose deserves.
  kw?: string[];
  status?: "open" | "settled";
  // "global" = cross-project (memory_remember global:true; imports carry a
  // row's origin stamp). Any other value (including undefined) is resolved by
  // appendMemory against the live repo scope.
  repo?: string;
  repoPath?: string;
}

// Metadata-list equality (retrieval keywords, tags): pairwise, undefined and
// empty counting as the same content. Shared by GATE-3's update carve-out and
// memory_update's successor verdict so both sides ask the same question.
// ORDER-SENSITIVE on purpose: ["a","b"] vs ["b","a"] counts as a metadata
// edit (a new row, the old one intact) — a set comparison would silently
// collapse an edit whose ordering the caller changed deliberately, and the
// conservative direction for a truth-claim is the one that writes more.
export const sameStrList = (a?: string[], c?: string[]) =>
  (a?.length ?? 0) === (c?.length ?? 0) && (a ?? []).every((x, i) => (c ?? [])[i] === x);

// The sentence every success reply owes the reader when the gate promoted a
// row but its write_promoted audit line failed to land (#155 review): the
// row IS durable — and memory_evidence, where every other verdict points
// the curious reader, will show NOTHING for it. Only silence was optional.
export const auditCaveat = (outcome: GateOutcome): string =>
  outcome.evidenceError !== undefined
    ? ` (its audit line was not recorded: ${outcome.evidenceError})`
    : "";

export interface GateContext {
  liveRoot: string;
  // Capture authority before awaiting locks, model calls, or gate evidence.
  // Named callers read their repo; named-unbound callers read global-only;
  // absent/"?" callers capture ambient authority at entry (not after awaits).
  reader?: Reader;
  writeAt?: WriteTarget;
  evidenceCalls: string[];
  // Total before the telemetry window was selected. Legacy/direct callers
  // may still supply their complete list; the writer bounds that too.
  evidenceCallsCount?: number;
  hasGateCheck: boolean;
  // The session this write belongs to, when the caller knows it by name.
  // Repo-stamp resolution prefers it over the mutable global current, which
  // a capture's model-call await can outlive into another session (#116).
  sessionID?: string;
  // True when the session exercised the code (read/grep/edit/bash results
  // recorded). Empirical engagement substitutes for hand-copied refs (gate
  // injection): the write encodes behavior that actually happened here, so the
  // formal gate check is not the only admissible grounding.
  hasEngagement?: boolean;
  // Plugin-authored bookkeeping (e.g. init stamps, script memories) bypasses
  // the GATE-4 ambiguity rule: it embeds no refs and has no completion-gate
  // evidence by construction, but is still evaluated by GATE-1/2/3.
  trusted?: boolean;
  // ts of the row this write replaces, when the caller is an update. GATE-3
  // excludes it from rivalry: the update IS the sanctioned supersession, so it
  // must never be blocked as a conflict with the row it is about to supersede.
  supersedesTs?: string;
  // Optional caller-owned ledger (#158 round 3): GATE-2's drift/canonical
  // supersessions append the ts values they made durable HERE, immediately
  // after the batch publish and BEFORE their audit lines — so a failed audit
  // line can no longer hide a persisted retirement from the caller's catch.
  // "Nothing was written" is only writable when this stays empty.
  durable?: string[];
}

// Shared optional fields remain readable by diagnostic callers before they
// narrow on action. The variants below require the fields each verdict owes.
interface GateOutcomeFields {
  reason?: string;
  ts?: string;
  chain: string;
  hint?: string;
  // Promoted with the row DURABLE but its post-append write_promoted audit
  // line failed (#155). Entry points with a further post-mutation step
  // (memory_update's supersede) must still run it and report a partial
  // result. Throwing was the old shape of this signal and it lied: callers
  // read it as "nothing happened" while the row sat on disk. Pre-append
  // faults keep throwing — there, nothing was in fact written.
  evidenceError?: string;
  // On a collapsed (un-stored) write: the ts of the ACTIVE row whose content
  // already IS the candidate. An update completing its supersession needs the
  // survivor's id to retire its own target in the survivor's favor (#155
  // convergence: a retry must be able to end with one active row).
  collapsedWith?: string;
}

export type GateOutcome =
  | (GateOutcomeFields & { action: "promoted"; ts: string })
  | (GateOutcomeFields & { action: "blocked"; reason: string })
  | (GateOutcomeFields & { action: "collapsed" });

// STOPWORDS, tokens, rawTokens and jaccard now live in tokenize.ts so the
// rejection sketch (#35) scores similarity with the same definition GATE-3
// uses. Imported below; behavior is byte-identical to the local copies.

// GATE-3 similarity floors. OVERLAP_FLOOR: reworded near-duplicates of any
// type are merge-review candidates. CONFLICT_OVERLAP_FLOOR: decisions and
// preferences compete sooner — a value swap on the same subject is a rivalry
// at moderate overlap, while distinct statements in a shared scope sit well
// below this band and must store clean.
const OVERLAP_FLOOR = 0.9;
const CONFLICT_OVERLAP_FLOOR = 0.3;

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

async function staleRefFor(m: Memory, liveRoot: string, tree: LazyTree): Promise<StaleRef | null> {
  for (const form of extractCallForms(m.content)) {
    const live = await findLiveCall(form.name, form.fileHint, liveRoot, await tree());
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
  const reader = ctx.reader ?? readerFromSid(ctx.sessionID);
  const writeAt = ctx.writeAt ?? writeTarget(ctx.sessionID ?? getCurrent().sid);
  const chain = chainId();
  // Gate audit lines thread the session: runWriteGate awaits (analysis, the
  // locked append), and another session's dispatch can move the ambient
  // current mid-gate — ambient-read lines would then name the wrong session
  // (#118 review note 1; the rows were fixed in #118, these were the
  // residue). Where ctx.sessionID is unset (tool paths — issue #121) record()
  // keeps the ambient read, exactly as before.
  const rec = (ev: string, fields: Record<string, unknown> = {}, includeContext = true) =>
    record(ev, fields, includeContext, ctx.sessionID);
  const recBlocked = (gate: number, reason: string, flags: string[], chain?: string) =>
    recordWriteBlocked(gate, reason, flags, chain, ctx.sessionID);

  // Size/type floor BEFORE any scanning: gate analysis regexes
  // over megabyte content backtrack super-linearly and freeze the service
  // event loop (100KB write = 6s, 2MB = never returned).
  if (typeof candidate.content !== "string") {
    await recBlocked(4, "invalid_content", [`content_type=${typeof candidate.content}`], chain);
    return { action: "blocked", reason: "invalid_content", chain, hint: "content must be a string." };
  }
  if (candidate.content.length > MAX_CONTENT_CHARS) {
    await recBlocked(4, "content_too_long", [`len=${candidate.content.length}`, `max=${MAX_CONTENT_CHARS}`], chain);
    return {
      action: "blocked",
      reason: "content_too_long",
      chain,
      hint: `content is ${candidate.content.length} chars (max ${MAX_CONTENT_CHARS}). Distill the memory to its durable core and retry.`,
    };
  }

  const badMetadata: string[] = ([
    ["type", candidate.type],
    ["scope", candidate.scope],
    ["issue", candidate.issue],
  ] as const)
    .filter(
      ([, value]) =>
        value !== undefined &&
        (typeof value !== "string" || flattenMemoryText(value) !== value),
    )
    .map(([field]) => field);
  if (
    candidate.tags !== undefined &&
    (!Array.isArray(candidate.tags) ||
      candidate.tags.some((tag) => typeof tag !== "string" || flattenMemoryText(tag) !== tag))
  ) {
    badMetadata.push("tags");
  }
  if (
    candidate.kw !== undefined &&
    (!Array.isArray(candidate.kw) ||
      candidate.kw.some((k) => typeof k !== "string" || flattenMemoryText(k) !== k))
  ) {
    badMetadata.push("kw");
  }
  if (badMetadata.length) {
    await recBlocked(4, "invalid_metadata", [`fields=${badMetadata.join(",")}`], chain);
    return {
      action: "blocked",
      reason: "invalid_metadata",
      chain,
      hint: `${badMetadata.join(", ")} must not contain control characters.`,
    };
  }

  const credentialMetadata = [
    containsSecret(candidate.scope) ? "scope" : undefined,
    candidate.tags?.some(containsSecret) ? "tags" : undefined,
    candidate.kw?.some(containsSecret) ? "kw" : undefined,
    containsSecret(candidate.issue) ? "issue" : undefined,
  ].filter((field): field is string => field !== undefined);
  if (credentialMetadata.length) {
    await recBlocked(
      4,
      "credential_in_metadata",
      credentialMetadata.map((field) => `field=${field}`),
      chain,
    );
    return {
      action: "blocked",
      reason: "credential_in_metadata",
      chain,
      hint: `Credential-shaped value in ${credentialMetadata.join(", ")}; remove it and retry. Only memory content is redacted automatically.`,
    };
  }

  // This is the common boundary for manual, imported and auto-captured writes.
  // Scrub content before hashing, analysis and persistence. Metadata is
  // rejected above rather than silently changing where a row can be found.
  candidate = {
    ...candidate,
    content: redactSecrets(candidate.content),
  };

  const ch = contentHash(candidate.content);
  await rec("gate_start", {
    chain,
    op: "write",
    scope: candidate.scope,
    type: candidate.type,
    ch,
  });

  const scopeMems = candidate.scope
    ? await loadScope(
        candidate.scope,
        reader,
      )
    : [];
  // One tree index per write, shared by gate1 and every gate2 stale scan.
  const tree = memoTree(ctx.liveRoot);

  // ---- GATE-1: canonical graph correct ------------------------------------
  const g1 = await gate1({
    content: candidate.content,
    scope: candidate.scope,
    liveRoot: ctx.liveRoot,
    scopeMemories: scopeMems,
    tree,
  });
  if (g1.drift) {
    await rec("graph_drift", {
      gate: 1,
      symbol: g1.drift.symbol,
      from: g1.drift.from,
      to: g1.drift.to,
      corrected: true,
      evidence: ctx.evidenceCalls[0] ?? "-",
      chain,
    });
  } else {
    await rec("graph_current", {
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
    const s = await staleRefFor(m, ctx.liveRoot, tree);
    if (s) stale.push(s);
  }
  const bailed = scopeMems.length === 0;
  await rec("ref_stale_scan", {
    gate: 2,
    scope: candidate.scope,
    delta: bracketList(delta),
    scanned: scopeMems.length,
    found: stale.length,
    bailed,
    chain,
  });

  let supersededTs: string | undefined;
  const driftPlan: { s: StaleRef; target: string; fields: SupersedeFields }[] = [];
  for (const s of stale) {
    await rec("ref_stale", {
      gate: 2,
      mem: s.memory.ts,
      scope: candidate.scope,
      ref: s.symbol,
      from: s.from,
      to: s.to,
      chain,
    });
    // Drift-fed supersession is AUTO (provable) and target depends on whether a
    // valid write will land; stale data is neutralized either way. One batch
    // publish for the whole set (#61): a row marked out-of-band between the scan
    // and the pass is skipped by the batch (it re-reads under the lock).
    const target = g1.candidateStale ? "<-" : chain;
    if (typeof s.memory.superseded_by === "string") continue;
    // The row an UPDATE replaces is retired by the update itself, with its
    // own pointer. A drift stamp here wins first-call-wins against the
    // caller's markSuperseded and leaves a chain id the caller's retry can
    // never walk — so the tool would print "(superseded X)" naming a
    // retirement it did not perform. Same principle GATE-3 applies to
    // rivalry (the target is never a contender): the update IS the sanctioned
    // supersession for that row.
    if (s.memory.ts === ctx.supersedesTs) continue;
    driftPlan.push({
      s,
      target,
      fields: { superseded_by: target, reason: "drift", symbol: s.symbol, from: s.from, to: s.to },
    });
  }
  if (driftPlan.length > 0) {
    const { marked } = await markManySupersededReport(driftPlan.map((p) => ({ ts: p.s.memory.ts, fields: p.fields })), ctx.durable);
    if (marked.length > 0) {
      // Ledger BEFORE the audit lines: what is on disk now stays on disk no
      // matter what the record loop below does (round-3 probe 3).
      for (const p of driftPlan) {
        supersededTs = p.s.memory.ts;
        await rec("superseded_by", {
          gate: 2,
          mem: p.s.memory.ts,
          target: p.target,
          reason: "drift",
          symbol: p.s.symbol,
          from: p.s.from,
          to: p.s.to,
          chain,
        });
      }
    }
  }

  if (canon) {
    await rec("canonical_hit", {
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
    const target = canon.aligns ? chain : "<-";
    const canonPlan: { ts: string; from: string | undefined }[] = [];
    for (const m of scopeMems) {
      if (m.superseded_by) continue;
      // The update's own target retires in the update's hand, not the
      // canonical registry's (see the GATE-2 drift skip above).
      if (m.ts === ctx.supersedesTs) continue;
      if (tokens(m.content).some((t) => valueSet.has(t))) continue;
      const from = rawTokens(m.content).find(
        (t) => !STOPWORDS.has(t.toLowerCase()) && !entitySet.has(t.toLowerCase()) && !valueSet.has(t.toLowerCase()),
      );
      canonPlan.push({ ts: m.ts, from });
    }
    // One batch publish for the whole neutralization set (#61); rows marked
    // out-of-band since the scan are skipped by the batch (re-read under lock).
    const { marked: canonMarked } = await markManySupersededReport(
      canonPlan.map((p) => ({
        ts: p.ts,
        fields: { superseded_by: target, reason: "canonical", entity: canon.entry.entity, from: p.from, to: canon.entry.value },
      })),
      ctx.durable,
    );
    if (canonMarked.length > 0) {
      // Same ledger discipline as the drift batch above.
      for (const p of canonPlan) {
        if (!supersededTs) supersededTs = p.ts;
        await rec("superseded_by", {
          gate: 2,
          mem: p.ts,
          target,
          reason: "canonical",
          entity: canon.entry.entity,
          from: p.from,
          to: canon.entry.value,
          chain,
        });
      }
    }
  }

  // ---- GATE-3: no dupes ----------------------------------------------------
  // #35: a value a human rejected stays rejected. This is the "have we already
  // seen this" gate, and it is the only place a rejection can be enforced
  // before a write becomes durable — but unlike every other check here, it is
  // keyed on the VALUE, not on row identity. The blocklist keys on `ts` and
  // prune deletes the row outright, so re-ingesting the original source (the
  // same transcript through auto-capture, the same export through
  // memory_import) stores a rejected fact again with a fresh `ts`, as if it had
  // never been turned down.
  //
  // Computed here, enforced at GATE-4, so the ordered evidence chain
  // (gate_start → gate1 → gate2 → dedup_*) stays intact for every verdict.
  const probe = await probeRejection(candidate.content);
  const rejection = probe.rejection;
  const conflictProne = candidate.type === "decision" || candidate.type === "preference";
  const active = scopeMems.filter((m) => !m.superseded_by);
  // Exact duplicates are detected against the full scope (a drift-superseded
  // twin still collapses), but overlap/merge only considers live entries.
  const exactPoll = scopeMems.filter(
    (m) => m.superseded_by === undefined || m.reason === "drift",
  );
  // Byte-exact duplicate prose collapses (Principle 2) — with one UPDATE-only
  // carve-out: the row being replaced counts as a duplicate of the candidate
  // only if the update also restates its metadata. Same prose plus different
  // retrieval keywords or status is a metadata EDIT on that row (GATE-3
  // already refuses to see it as a rival), and collapsing it would silently
  // drop the edit — the tool could then never edit kw or status at all.
  const exact = exactPoll.find(
    (m) =>
      m.type === candidate.type &&
      m.content === candidate.content &&
      (m.ts !== ctx.supersedesTs ||
        (sameStrList(m.kw, candidate.kw) &&
          sameStrList(m.tags, candidate.tags) &&
          m.issue === candidate.issue &&
          (m.status ?? "settled") === (candidate.status ?? "settled"))),
  );
  // Same-type live rows that could compete with the incoming statement; the
  // row an update replaces is never a contender.
  const live = active.filter((m) => m.type === candidate.type && m.ts !== ctx.supersedesTs);
  const divergent = live.filter((m) => m.content !== candidate.content);

  let collapseMatch: Memory | undefined;
  let overlapMatch: Memory | undefined;
  let overlapScore = 0;

  // A rival is a live same-type row stating the same thing differently enough:
  // it must clear a similarity floor, not merely exist. conflictProne types
  // compete at a lower floor than plain rewordings because a value swap
  // ("use Express" vs "use Fastify") is a genuine rivalry far below the
  // rephrase band, while topically distinct decisions/preferences in one
  // scope are normal coexisting statements, not conflicts. A canonical that
  // covers the statement already settles rivalry, so conflictProne types skip
  // the scan; the row an update replaces is never a contender.
  const floor = conflictProne ? CONFLICT_OVERLAP_FLOOR : OVERLAP_FLOOR;
  const contenders = !conflictProne ? live : canon ? [] : divergent;
  let rival: { m: Memory; score: number } | undefined;
  for (const m of contenders) {
    const score = jaccard(tokens(candidate.content), tokens(m.content));
    if (score >= floor && (!rival || score > rival.score)) rival = { m, score };
  }

  if (
    exact &&
    !exact.superseded_by &&
    (canon?.aligns || !(conflictProne && rival))
  ) {
    // Byte-identical duplicate collapses (Principle 2) — exactness is
    // independent of the canonical registry, so a decided/preferred fact
    // restated verbatim is never "conflicting" content on its own. Two
    // exceptions keep the S4/S4b semantics: a canonical that aligns resolves
    // the rivalry (echo collapses), but a scope already holding a RIVAL
    // decision/preference entry (over the conflict floor) with no resolving
    // canon keeps the exact restatement review-gated — dedup must not silently
    // bury a conflict.
    collapseMatch = exact;
  } else if (rival) {
    // Review-gated merge: a competing decision/preference, or a reworded
    // near-duplicate of a live row.
    overlapMatch = rival.m;
    overlapScore = Math.round(rival.score * 100) / 100;
  }

  // A declined near-match, recorded so the guard is falsifiable in the field:
  // without this line "it never over-blocks a correction" is a claim with no
  // evidence either way, and this is exactly the kind of judgement that needs
  // counting where it happens. Only reached when nothing refused the write.
  if (!rejection && probe.vetoed) {
    await rec("rejection_vetoed", {
      gate: 3,
      survivors: scopeMems.length,
      match_ch: probe.vetoed.tombstone.ch,
      score: probe.vetoed.score,
      differs: probe.vetoed.differs,
      action: "allow_different_fact",
      chain,
    });
  }

  if (rejection) {
    // The prior rejection's own hash, never the prose: the atlas step-10
    // inversion is a deletion log that reproduces what it deleted.
    await rec("dedup_rejected", {
      gate: 3,
      survivors: scopeMems.length,
      match_ch: rejection.tombstone.ch,
      match_kind: rejection.kind,
      ...(rejection.kind === "near" ? { score: rejection.score } : {}),
      rejected_at: rejection.tombstone.rejected_at,
      action: "refuse_previously_rejected",
      chain,
    });
  } else if (collapseMatch) {
    await rec("dedup_collapse", {
      gate: 3,
      survivors: scopeMems.length,
      match: collapseMatch.ts,
      ch,
      action: "canonical_existing",
      incoming_ignored: true,
      chain,
    });
  } else if (overlapMatch) {
    await rec("dedup_overlap", {
      gate: 3,
      survivors: scopeMems.length,
      candidate: overlapMatch.ts,
      score: overlapScore,
      action: "propose_merge",
      chain,
    });
  } else {
    await rec("dedup_clean", {
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
  if (rejection) {
    // First in the chain: every other reason here is a heuristic about the
    // write's shape, and a human already made a decision about this value.
    blockReason = "previously_rejected";
    blockFlags =
      rejection.kind === "exact"
        ? [`ch=${rejection.tombstone.ch}`, "exact"]
        : [`ch=${rejection.tombstone.ch}`, `score=${rejection.score}`, "near_match"];
    const when = rejection.tombstone.rejected_at.slice(0, 10) || "an earlier session";
    // Scrubbed here as well as on the way in and on the way out of tombstones():
    // this string goes to the model, and the hint is built from a field a human
    // typed. If the row already came through clean this is a no-op — deleting it
    // changes nothing observable today, which is deliberate: the guarantee lives
    // on the read path (it covers every consumer, the viewer included), and this
    // is the seam where the value becomes a model-facing sentence.
    const why = redactSecrets(rejection.tombstone.reason) || "no reason recorded";
    const tch = rejection.tombstone.ch;
    // The escape-hatch tail is shared by BOTH kinds. An earlier draft put it
    // only on the near-match branch, which left the COMMON case — a byte-exact
    // replay — reported as a dead end with no way to lift it.
    const lift =
      `If this is genuinely a different fact, state it in clearly different terms; ` +
      `if the earlier rejection was wrong, a human can lift it in the viewer ` +
      `(Rejections → un-reject, hash ${tch}) — there is deliberately no tool that ` +
      `lifts a rejection, so a blocked write cannot be re-submitted by the session ` +
      `it was refused.`;
    hint =
      (rejection.kind === "exact"
        ? `This exact content was rejected on ${when} (reason: ${why}; hash ${tch}). Nothing was stored. `
        : `Content ${rejection.score} similar to a value rejected on ${when} (reason: ${why}; ` +
          `hash ${tch}) — the same statement reworded counts as the rejected value. Nothing was stored. `) + lift;
  } else if (g1.candidateStale) {
    blockReason = "drift_ref_stale_incoming";
    blockFlags = ["incoming_embeds_pre_drift_ref"];
  } else if (g1.missingPaths.length && !planningObject) {
    // A settled claim about code must point at files that exist. Open
    // planning threads are exempt — plans routinely cite files not yet
    // created.
    blockReason = "ref_path_missing";
    blockFlags = [`missing=${g1.missingPaths.join(",")}`];
    hint = `Path ref(s) not found in the repo: ${g1.missingPaths.join(", ")}. Rephrase against the current tree (drop the path or fix it) and retry; use status="open" if the file is planned, not existing.`;
  } else if (canon && !canon.aligns) {
    blockReason = "conflicts_with_canonical";
    blockFlags = [
      `canonical=${canon.entry.value}`,
      `incoming=${canon.conflictingValue ?? "?"}`,
    ];
  } else if (overlapMatch) {
    blockReason = "superseded_overlap";
    blockFlags = [`supersedes_check_${overlapMatch.ts}`, `score=${overlapScore}`, "review_gated"];
    hint =
      `A live ${candidate.type} row ${overlapMatch.ts} in ${candidate.scope || "(no scope)"} competes ` +
      `with this write (overlap ${overlapScore}). Nothing was stored. To replace that row, use ` +
      `memory_update with query="${overlapMatch.ts}" — an update supersedes its target instead of ` +
      `conflicting with it. If both statements should stand, store this one under a distinct ` +
      `scope. memory_merge_review resolves proposals between stored rows only; this candidate was ` +
      `never stored, so it cannot be resolved from here.`;
  } else if (ambiguous && !collapseMatch) {
    blockReason = "ambiguous_memory";
    blockFlags = flags;
    if (looksPlanning(candidate)) {
      hint =
        'Looks like an open planning thread. Retry with status="open" and a non-empty scope to store it as a frontier item, or run the completion gates to ground it.';
    }
  }

  if (blockReason) {
    await recBlocked(4, blockReason, blockFlags, chain);
    if (blockReason === "superseded_overlap" && overlapMatch) {
      const newest = scopeMems[scopeMems.length - 1] ?? overlapMatch;
      // Advisory, not actionable: the incoming candidate was never persisted,
      // so no memory_merge_review loser exists for it. The line is rivalry
      // telemetry and a pointer to the stored rival.
      await rec("merge_proposal", {
        candidate: overlapMatch.ts,
        incoming: chain,
        canonical: newest.ts,
        source: `durable_${candidate.type}`,
        review: "advisory",
        incoming_stored: false,
        chain,
      });
    }
    return { action: "blocked", reason: blockReason, chain, hint };
  }

  if (collapseMatch) {
    return { action: "collapsed", chain, collapsedWith: collapseMatch.ts };
  }

  // The write is specifically promoted on engagement (no refs, no gate check,
  // not canonical, not an open object). Emitted so the precedent is auditable.
  const groundedByEngagement =
    !ctx.trusted && !canon && !planningObject &&
    g1.refs === 0 && !ctx.hasGateCheck &&
    ctx.hasEngagement === true && candidate.scope !== "";
  if (groundedByEngagement) {
    await rec("gate_injected", { gate: 4, chain });
  }

  const snapshot = await snapshotFiles([join(memoryRoot(), `${new Date().toISOString().split("T")[0]}.logfmt`)]);
  // The write carries the CALLER's session, not whatever current says after
  // the gate's own awaits - capture's stamp must follow the captured session.
  if (candidate.repo === undefined && !writeAt.ok) throw new UnresolvedWriterError(writeAt.sid);
  // A captured unscoped ambient writer deliberately publishes repo=global.
  // Leaving repo undefined would make appendMemory resolve ambient ownership
  // again after awaits. This changes the old unstamped shape: exports now keep
  // this row global on import instead of adopting the importing repository.
  const owner = candidate.repo === undefined && writeAt.ok
    ? { repo: writeAt.scope?.key ?? "global", repoPath: writeAt.scope?.path }
    : {};
  const ts = await appendMemory({ ...candidate, ...owner, sessionID: ctx.sessionID });
  // #165: remember who made this row, so the writing session is not billed a
  // prompt-cache bust to be shown its own thought. Only promoted writes are
  // attributed — a blocked candidate created nothing.
  noteAuthored(ctx.sessionID, ts);
  // Everything past the append is durable state: an audit failure from here
  // must not escape as a throw, or the caller reports a write that happened
  // as if it had not (#155 — memory_update told the model "Nothing was
  // written" while the replacement row sat un-superseded on disk). The
  // outcome carries the error instead.
  let evidenceError: string | undefined;
  try {
    await rec("write_promoted", {
      gate: 4,
      op: "write",
      mem: ts,
      scope: candidate.scope,
      type: candidate.type,
      status: candidate.status ?? "settled",
      ch,
      supersedes: supersededTs ?? "-",
      canonical: canon ? `canonical.logfmt:${canon.entry.ts}` : "-",
      evidence_refs: bracketList(ctx.evidenceCalls.slice(-MAX_WRITE_EVIDENCE_REFS)),
      evidence_refs_count: ctx.evidenceCallsCount ?? ctx.evidenceCalls.length,
      snapshot: snapshot[0] ?? "-",
      trusted: ctx.trusted ? true : undefined,
      grounded_by: groundedByEngagement ? "engagement" : undefined,
      chain,
    });
  } catch (err) {
    // NOT `(err as Error).message`: a messageless Error (or a non-Error
    // rejection) would make the field FALSY, and callers test it for truth —
    // the lie this field exists to kill would return as a clean success.
    evidenceError = err instanceof Error && err.message ? err.message : String(err);
  }
  return { action: "promoted", ts, chain, evidenceError };
}
