# Self-Improving Harness — OpenCode Extension Spec

Status: BUILDING (Phase 1 implemented in `src/`, exercised by `test/scenarios.test.ts`). This file is the authoritative behavior contract for `@abogartz/opencode-self-improvement`; harness code changes only when a scenario demands it, and the contract is versioned here. Ported from an earlier working-plan document. Last updated 2026-09-17.

> Note on labels: the DECISION/CANDIDATE blocks below are retained verbatim as the design record. Mechanistic wording (CBM file graph, /refine) names the *intended* production wiring; this package implements the observable behavior contract with a self-contained local resolver (see `src/resolver.ts`) so it installs from scratch. Scenario/chains/invariants are normative.

> DECISION 2026-09-16 — **pull-with-tiny-digest** (fork B, user-chosen). Prime's pillar-1 mechanism gets ported, not skipped: `context is a view over durable state, pulled on demand` instead of `inject durable memory as text`. Concrete implications (Phase 0 rewires): (1) `tool.execute.after` intercepts HIGH-VOLUME tool output (large grep/glob/read, test/tsc/lint dumps) → writes to a local `kernel-lite` KV store → returns the model a **pointer + tiny preview** instead of full text; (2) injected durable memory shrinks to a **tiny digest** (e.g. ≤2 lines: "N memories exist in scope X; latest: <ts interval>; use memory_recall to pull"). The model PULLS durable knowledge on demand rather than having it pushed wholesale. This is the change most responsible for Prime's 30→95. (Digest replaces MAX_INJECT text-injection; see Phase 0 below.)

> DECISION 2026-09-16 — **pull mechanism = C**: contextual pull (deterministic, tool-bound: `tool.execute.before` / message-transform injects *related* memory as evidence when the model is about to grep/glob/read in a scope — rides existing tool calls, no new model-voluntary behavior; this is what cbm-augment already does for graph nodes) **+** explicit `memory_recall(key|scope)` tool as an escape hatch the model can call on demand. Both, not either. Digest stays tiny; the contextual pull does the heavy lifting without requiring the model to "decide to pull" anything.

> DECISION 2026-09-16 — **budget model = C**: hard cap ONLY on what actually enters context (the injected tiny digest — an enforcible token ceiling, deterministic), NOT a numeric memory-count cap; durable-store growth is instead watched by a **compaction-triggered tighten pass** (experimental.session.compacting fires a /refine "shrink/consolidate" gate that must propose merges/dedup before any new promotion proceeds — Prime's "compaction loops keep memory small") with promotion review-gated. Numbers stay un-arbitrary (they emerge from usage), growth is tightened at compaction, and the one place tokens could flood is capped by construction. Replaces the MAX_INJECT=10 text-cap model in Dependencies below.

> DECISION 2026-09-17 — **drift repair = B** (user-chosen): resolve-on-use + gate-coupled. The CBM/AST file-graph is a derived index (canonical anchor #2, after AGENTS.md, before durable memory); memories embed path/symbol refs that can go stale when symbols move/rename/delete. Repair backbone (deterministic, evidence-backed, rides existing hooks — no new model-voluntary behavior):
>
> - **(a) resolve-on-use**: EVERY pull (contextual pull via tool.execute.before/message-transform, or memory_recall) re-resolves the memory's embedded path/symbol refs against the LIVE CBM file-graph at pull time. Stale ref → returned FLAGGED (e.g. `ref_stale: table_manager → services/table_manager.ts:42 (was test/table_manager.test.ts)`). Flagged refs become deterministic evidence for a /refine drift-fix proposal. Cheapest, catches exactly what's actually pulled; never-pulled memories cost nothing. This is Prime-faithful: Prime has no "reconcile pass" because the kernel re-resolves refs at access — we port resolve-at-access, not re-index.
>
> - **(b) gate-coupled**: on a completion-gate FAIL→PASS (T4), /refine ALSO checks whether the pre-PASS failure chain involved a stale memory ref (i.e. a symbol that moved breaking a test IS a stale-ref event); if so, promotes a `ref_stale` correction. Ties drift repair to where bugs actually surface (the gate), catches drift for memories nobody pulled, without any periodic re-scan.
>
> DELIBERATELY NOT (c) a full compaction/digest re-scan: cost grows with memory count (budget=P1 violation). (b) is the compact, deterministic seam. Replaces "re-index then reconcile on a schedule" in Open questions below. Source of truth precedence: AGENTS.md > live CBM file-graph index > durable memory.

> DECISION 2026-09-17 — **design method = behavior-first (outside-in, user-chosen)**. Mechanisms are provisional candidates; the OBSERVABLE BEHAVIOR CONTRACT is the spec. We write it as test scenarios FIRST (deterministic, reproducible, asserting exactly what the system must do step-by-step), the write-gate sequence below is the anchor contract, and every Prime pillar-1 mapping (pull-with-tiny-digest, resolve-on-use, gate-coupled (b), budget=C, drift=B) in the DECISION blocks above is DEMOTED to *candidate implementation* until the behavior suite passes. Prime-faithful in method too: Prime proved harness-with-same-weights via observable behavior change (30→95.5), not via attaining internal mechanism identity. So all "DECISION" blocks below are renamed "CANDIDATE" — mechanism can change if a scenario fails. Behavior is law; mechanism is derived.

> DECISION 2026-09-17 — **supersession model (locked; the key mechanic)**. Supersession FOLDS INTO GATE-2; the anchor contract stays exactly 4 gates (1→2→3→4). Three flavors; only two auto, distinguished by provability:
>
> - **(a) drift-fed — AUTO (provable)**: a memory embedding a pre-drift ref (same scope/symbol) is `superseded_by` the incoming write — a computation off `graph_drift{from→to}`, no judgment, NO deletion (entry retained, marked, snapshot+audit recoverable). This is the "method signature updated" poison-guard; the whole thesis hinges on it. Stale data poisons the system; supersession-first is the antidote.
> - **(c) canonical-fed — AUTO but authority-bound**: auto-supersede only when a human-approved **canonical-registry** line resolves the conflict. Registry = `memory/canonical.logfmt` (`ts type=canonical entity= value= scope= source= review=`), populated ONLY via /refine + human review; NEVER parsed from AGENTS.md prose (repo AGENTS.md is out of our control; prose parsing is non-deterministic). Match key = scope + entity-token containment (tokens present in BOTH lines) + value compare — pure string logic. AGENTS.md stays human authority; registry is its machine projection. Precedence: AGENTS.md > canonical registry > live CBM file-graph > durable memory.
> - **(b) decision-fed WITHOUT registry — review-gated**: fuzzy overlap → `dedup_overlap` + `merge_proposal`; human decides; NEVER guessed, NEVER auto-emitted (`superseded_by` is drift/canonical-only).
>
> **GATE-3 dedups survivors ONLY** — never reconciles a superseded or incoming-stale entry with fresh truth (that reconciliation IS the poisoning). Incoming-stale / anti-canonical writes are **BLOCKED**, AND the losing pre-existing memory is neutralized (`superseded_by`) even when no good write arrives — stale data doesn't survive on "the fix never landed." `superseded_by` is idempotent (no double-mark). Mechanisms listed are candidates; the S1–S6 / S-edge / S4b-* chains in the concrete suite below ARE the spec.

## Behavior spec — write-gate sequence (canonical anchor contract; MUST test)

The user-specified observable behavior (English, direct from requirement): *"A turn reveals a test bug after a method signature is updated. The system attempts to write this fact as a memory. Before doing so, it MUST: (a) confirm that the canonical graph is now correct (updating if necessary), and (b) look for ANY stale memories that apply here, and (c) look for dupes, THEN (d) write the new memory."*

Deterministic write-gate (hooks verified in installed SDK: `tool.execute.before`/`tool.execute.after` intercept the plugin's write tool `memory_remember` (and `memory_update`/`memory_forget`); `memory_recall` is the read path — NO model-voluntary behavior):

1. **GATE-1 (canonical-graph correct)**: before ANY memory write/promotion, /refine re-resolves the memory's embedded path/symbol refs against the LIVE CBM file-graph + AST index; if the live index differs from what the memory/evidence embeds (signature moved, symbol renamed/relocated — exactly what "method signature updated" means), it emits a deterministic correction event: `graph_drift {symbol, from, to, evidence}` and UPDATES the canonical graph to the live truth BEFORE proceeding. Write is BLOCKED until GATE-1 passes.
2. **GATE-2 (no stale memories apply here)**: after GATE-1 updates the graph, /refine determines the *scope delta* (anything that changed) and re-scans durable memory for existing entries whose embedded refs point at the pre-drift targets of the SAME scope (min-cost: bail early once no candidate in scope). Any stale ref → FLAGGED evidence `ref_stale` → becomes a /refine drift-fix proposal (drift=B backbone). GATE-2 does NOT auto-delete; it surfaces.
3. **GATE-3 (no dupes)**: before promotion, dedup vs (scope, type, content-similarity) — determine if the candidate memory duplicates or overlaps existing durable entries (Principle 2). Duplicate → collapse to canonical; overlap → /refine proposes merge. Auto-collapse only exactly-equal (scope+type+content); everything else review-gated.
4. **GATE-4 (write)**: only after GATE-1/2/3 all PASS does the new memory promote (evidence-backed, snapshot, rollback). Any gate failure → the write is BLOCKED and the gate's evidence becomes the /refine proposal the human reviews (never auto-applied to deletions/or harness).

> DECISION-bracket note: behaviors are the contract; these mechanics are the CURRENT best guess at satisfying them. If a behavior-suite scenario fails, mechanics change — not the contract. Contradicts ("re-index then reconcile on a schedule") in Open questions below; behavior-first supersedes.

## Behavior suite — concrete scenarios + evidence schema (behavior-first spec; supersedes the sketches in the DECISION blocks above)

> Contract note: every scenario asserts TWO halves — (1) **data-path** (an ordered, machine-checkable evidence-chain for the write) and (2) **gate-coupled** (the write rode the deterministic /refine seam via `tool.execute.before`, not a write masquerading as chat or a direct file append). A scenario PASSes iff both halves hold. Directories: evidence = `~/.config/opencode/memory/evidence/<date>.logfmt`; snapshots = `~/.config/opencode/memory/snapshots/`; canonical registry = `~/.config/opencode/memory/canonical.logfmt`. All outside the repo (I2).

### Evidence line schema (machine-checkable)

Format: logfmt (`key=value`, values with spaces/special chars quoted), one event per line, appended in hook order to `evidence/<date>.logfmt`. `ch = sha1(candidate_text).slice(0,12)`. Common fields (every line): `ts` (UTC ISO), `sid` (sessionID), `call` (tool callID). Gate lines also carry `chain=<gate_run_id>`; durable entries are referenced by `mem=<their ts in memory/<date>.logfmt>`.

| `ev` | fires in | fields |
|---|---|---|
| `gate_start` | `tool.execute.before` on `memory_remember`/`memory_update` | `chain op=write scope type ch` |
| `graph_current` | GATE-1, clean | `gate=1 refs=n resolved=<symbols>` |
| `graph_drift` | GATE-1, drift found | `gate=1 symbol from to corrected=true evidence=<ref>` |
| `ref_stale_scan` | GATE-2 | `gate=2 scope delta scanned=n found=n bailed=true\|false` |
| `ref_stale` | GATE-2, per stale entry | `gate=2 mem scope ref from to` |
| `superseded_by` | GATE-2, drift or canonical | `gate=2 mem target=<chain\|-> reason=drift\|canonical [symbol from to \| entity from to]` |
| `canonical_hit` | GATE-2 | `gate=2 entity value scope source=` |
| `conflicts_with_canonical` | GATE-2 | `gate=2 entity canonical= incoming=` |
| `dedup_clean` | GATE-3 | `gate=3 survivors=n candidate=0` |
| `dedup_collapse` | GATE-3, exact dup | `gate=3 survivors=n match ch action=canonical_existing incoming_ignored=true` |
| `dedup_overlap` | GATE-3, fuzzy | `gate=3 survivors=n candidate score action=propose_merge` |
| `write_promoted` | GATE-4 | `gate=4 op=write mem scope type ch supersedes=<-|ts> canonical=<-|ref> evidence_refs=[...] snapshot=` |
| `write_blocked` | any gate | `gate=<n> reason=<enum> flags=[...]` |
| `t1_evidence` | T1 (tool retry FAIL→PASS) | `from=FAIL to=PASS evidence_refs=[c1,c2] kind=learning\|pattern` |
| `t4_learning` | T4 (completion gate) | `type=learning gate="bash:npx vitest run" from=FAIL to=PASS gate_couple=true evidence_chain=[...] fix_ref=<call>` |
| `gate_check` | 4-check bash invocations (vitest/playwright/lint/tsc) | `cmd=vitest\|playwright\|lint\|tsc status=FAIL\|PASS` |
| `prune` | `memory_forget` (before) | `mem reason="..." snapshot= audit=` |
| `merge_proposal` | GATE-2/3 review path | `candidate incoming canonical=<ts\|-> source= review=required` |
| `tool_result` | generic capture | `tool title output_summary` |

`write_blocked.reason` enum: `ambiguous_memory` · `superseded_overlap` · `drift_ref_stale_incoming` · `conflicts_with_canonical` · `gate_order_violation`.

### Global invariants (asserted in every scenario)

- **I0 no-bypass**: every durable line added inside the scenario window maps 1:1 to a preceding `write_promoted` (matching `scope type ch mem=ts`). Any durable line without that evidence → FAIL.
- **I1 gate order**: within a `chain`, `gate=` strictly 1→2→3→4 and `ts` monotonic; never a later gate before an earlier one.
- **I2 repo-hermetic**: no evidence/snapshot/audit path points into the repo; nothing in the suite touches the repo.
- **I3 evidence never injected**: no evidence line and no `memory/evidence/*` filename appears in `experimental.chat.system.transform` output (evidence is data, never chat).

### S1 — signature-update-turn (the anchor contract)

**Setup.** CBM graph has `table_manager.save(opts)` at a live path:line. Durable M1 = `ts=T1 type=pattern scope=ctl content="use table_manager.save(opts)"`. Evidence dir empty. Source updated to `save(config, opts)` before the turn.

**Stimulus.** Turn runs `npx vitest run` → FAIL at call site → grep → read → edit → `npx vitest run` → PASS. Then `memory_remember{type=pattern scope=ctl content="use table_manager.save(config, opts)"}`.

**Expected chain.**
```
gate_check{call=C1 cmd=vitest status=FAIL}
gate_check{call=C5 cmd=vitest status=PASS}
gate_start{chain=G op=write scope=ctl type=pattern ch=H}
graph_drift{gate=1 symbol=table_manager.save from=save(opts) to=save(config, opts) corrected=true evidence=<C1>}
ref_stale_scan{gate=2 scope=ctl delta=[table_manager] scanned=1 found=1 bailed=false}
ref_stale{gate=2 mem=T1 scope=ctl ref=table_manager.save from=save(opts) to=save(config, opts)}
superseded_by{gate=2 mem=T1 target=G reason=drift symbol=table_manager.save from=save(opts) to=save(config, opts)}
dedup_clean{gate=3 survivors=1 candidate=0}
write_promoted{gate=4 mem=T2 scope=ctl type=pattern ch=H supersedes=T1 evidence_refs=[C1,C2,C3,C4,C5] snapshot=<S>}
```
**Assert A (data-path):** the exact ordered sequence above; an in-chain `graph_current` → FAIL; `supersedes=T1` present; `evidence_refs` contains the two `gate_check` callIDs and the edit call; durable store holds M1 present-but-marked and exactly one new M2 line (I0); no `write_blocked`, no `dedup_overlap`.
**Assert B (gate-coupled):** write entered via `gate_start`; FAIL strictly precedes PASS, both precede `gate_start` (I1); no evidence path touches the repo (I2); I3 holds.
**PASS** iff A ∧ B; mis-order, `graph_current`, a second M2, or an unflagged M1 → FAIL.

### S2 — blank/ambiguous-memory (capture yes, promote no)

**Setup.** Empty durable store; graph current.

**Stimulus.** grep no-match → grep re-query (different pattern) → hit. Then `memory_remember{type=learning scope="" content="tests pass now"}`.

**Expected chain.**
```
t1_evidence{from=FAIL to=PASS evidence_refs=[c1,c2] kind=learning}
gate_start{chain=G op=write scope="" type=learning ch=H}
graph_current{gate=1 refs=0}
ref_stale_scan{gate=2 scope="" delta=[] scanned=0 found=0 bailed=true}
dedup_clean{gate=3 survivors=0 candidate=0}
write_blocked{gate=4 reason=ambiguous_memory flags=[empty_scope,no_embedded_refs,no_evidence_refs]}
```
**Assert A:** the six lines in order; `bailed=true`; block reason + both flags; durable store empty at end.
**Assert B:** T1 capture happened (retry-pattern evidence exists — capture is legal); block was gate-initiated; nothing durable written (I0); captured evidence never narrated into chat (I3).

### S3 — duplicate-write-attempt (Principle 2)

**Setup.** M1 = `learning/auth` "use bcrypt for password hashing". Graph current.

**Stimulus.** Byte-identical second `memory_remember{learning, auth, "use bcrypt…"}`.

**Expected chain.**
```
gate_start{chain=G op=write scope=auth type=learning ch=H}
graph_current{gate=1 refs=0}
ref_stale_scan{gate=2 scope=auth scanned=1 found=0 bailed=false}
dedup_collapse{gate=3 survivors=1 match=T1 ch=H action=canonical_existing incoming_ignored=true}
(write_promoted ABSENT; no GATE-4 line)
```
**Assert A:** no `write_promoted`, no GATE-4 line at all; durable logfmt byte-identical after. **Assert B:** intercept via `gate_start`; collapse internal to the gate. Any durable delta → FAIL.

### S4 — superseded-memory, decision-fed, NO registry (review-gated)

**Setup.** M1 = `decision/backend` "use Express for API routing"; M2 (later) = `decision/backend` "use Fastify for API routing". Registry silent on scope/entity. AGENTS.md silent. Graph current.

**Stimulus.** `memory_remember{decision, backend, "use Fastify for API routing"}`.

**Expected chain.**
```
gate_start{chain=G op=write scope=backend type=decision ch=H}
graph_current{gate=1 refs=0}
ref_stale_scan{gate=2 scope=backend scanned=2 found=0 bailed=false}
dedup_overlap{gate=3 survivors=2 candidate=T1 score=0.6 action=propose_merge}
write_blocked{gate=4 reason=superseded_overlap flags=[supersedes_check_M2,review_gated]}
merge_proposal{candidate=T1 incoming=G canonical=M2 source=durable_decision review=required}
```
**Assert A:** the five chain lines + `merge_proposal`; M1/M2 files byte-identical; NO `superseded_by` (fuzzy can never emit it); no `write_promoted`. **Assert B:** block gate-initiated; canonical named; review-required marker. Any auto-supersede or auto-collapse → FAIL.

### S5 — prune-a-bad-memory (Principle 3)

**Setup.** M1 = `pattern/testing` "always run vitest before playwright". Snapshot dir initialized.

**Stimulus.** Human: `memory_forget{scope=testing type=pattern reason="playwright now gates CI first"}`.

**Expected chain.** `prune{mem=T1 reason="playwright now gates CI first" snapshot=<S> audit=<deletions.logfmt path> tool=memory_forget}`

**Assert A:** memory gone; audit row carries the exact reason; snapshot file exists and contains M1 (rollback possible). **Assert B:** triggered by the tool call (deterministic), not chat-narration or free-text delete; no repo touch (I2). Missing snapshot/audit/reason → FAIL.

### S6 — FAIL→PASS-gate → learning (T4)

**Setup.** Empty durable store; graph current.

**Stimulus.** Bug-fix turn: `npx vitest run` FAIL ("save expects 2 args") → grep → read → edit (adds second arg) → `npx vitest run` PASS; tool calls C1…C5.

**Expected chain.**
```
gate_check{call=C1 cmd=vitest status=FAIL}
tool_result{call=C2 tool=grep ...}
tool_result{call=C3 tool=read ...}
tool_result{call=C4 tool=edit ...}
gate_check{call=C5 cmd=vitest status=PASS}
t4_learning{type=learning gate="bash:npx vitest run" from=FAIL to=PASS gate_couple=true evidence_chain=[C1,C2,C3,C4,C5] fix_ref=C4}
```
**Assert A:** `t4_learning` exists with `gate_couple=true`, `evidence_chain` exactly the five real callIDs, `fix_ref=C4` (the edit whose output the PASS verified). **Assert B:** chain refers to real tool calls reproducible from the same evidence file; any `t4_learning` with `gate_couple=false` in the window → FAIL; no chat-narrated learning without a gate seam.

### S-edge — incoming-stale write (the poisoning guard)

**Setup.** M1 = `pattern/ctl` "use table_manager.save(opts)"; graph now live at `save(config, opts)`.

**Stimulus.** `memory_remember{pattern, ctl, "use table_manager.save(opts)"}` — stale truth, byte-identical to M1.

**Expected chain.**
```
gate_start{chain=G op=write scope=ctl type=pattern ch=H}
graph_drift{gate=1 symbol=table_manager.save from=save(opts) to=save(config, opts) corrected=true ...}
ref_stale_scan{gate=2 scope=ctl delta=[table_manager] scanned=1 found=1 bailed=false}
ref_stale{gate=2 mem=T1 scope=ctl ref=table_manager.save from=save(opts) to=save(config, opts)}
superseded_by{gate=2 mem=T1 target=<- reason=drift ...}   ← M1 neutralized even though the incoming write fails
dedup_collapse{gate=3 survivors=? match=T1 ch=H action=canonical_existing incoming_ignored=true}
write_blocked{gate=4 reason=drift_ref_stale_incoming flags=[incoming_embeds_pre_drift_ref]}
```
**Assert A:** GATE-1→2→3→4 all present (I1); drift emitted BEFORE any dedup; final `write_blocked{reason=drift_ref_stale_incoming}`; no incoming line promoted — only the `superseded_by` marker on M1 (retained, recoverable). **Assert B:** block gate-initiated (chain exists); the incoming stale write was NOT silently reconciled onto M1 — dedup ran, yet the write still failed on the drift finding (I0). Any promoted stale line → FAIL.
**Why this is the thesis case:** dedup-first would have collapsed incoming-stale onto M1 and called it done — two identical lies "reconciled." Drift-first surfaces graph truth and refuses. S-edge asserts exactly that sequence.

### S4b — canonical registry supersession (all auto at GATE-2; registry = `memory/canonical.logfmt`)

Match key is pure string logic: registry `scope` equals write's `scope` AND entity tokens appear in both lines; then value compare. No registry hit → fall through to S4 (review-gated).

- **S4b-i — canonical aligns with incoming** (M1="use Express for API routing"; registry `entity="API routing" value=Fastify scope=backend source=AGENTS.md:42`; incoming "use Fastify…"):
  ```
  gate_start{...}  graph_current{gate=1 refs=0}
  canonical_hit{gate=2 entity="API routing" value=Fastify scope=backend source=AGENTS.md:42}
  superseded_by{gate=2 mem=T1 target=G reason=canonical entity="API routing" from=Express to=Fastify}
  dedup_clean{gate=3 survivors=1 candidate=0}
  write_promoted{gate=4 mem=T2 supersedes=T1 canonical=canonical.logfmt:<regts>}
  ```
- **S4b-ii — anti-canonical incoming** (same M1; incoming re-asserts "use Express"):
  ```
  gate_start{...}
  graph_current{gate=1 refs=0}
  canonical_hit{gate=2 entity="API routing" value=Fastify scope=backend source=AGENTS.md:42}
  superseded_by{gate=2 mem=T1 target=<- reason=canonical ...}   ← losing memory dies EVEN WITHOUT a good write
  dedup_clean{gate=3 survivors=0 candidate=0}
  write_blocked{gate=4 reason=conflicts_with_canonical flags=[canonical=Fastify incoming=Express]}
  ```
  Durable store: M1 marked `superseded_by`; incoming never promoted. Stale data does not survive on "the fix never arrived."
- **S4b-iii — canonical echo** (durable M2 already holds Fastify; incoming "use Fastify"): `canonical_hit` → `dedup_collapse{match=M2}` (as S3, plus the `canonical_hit` recorded).

**Idempotency assert (S1 + S4b-*):** re-running the gate sequence on an already-marked memory emits NO second `superseded_by`.

### Phase mapping

| Scenario | hooks ridden |
|---|---|
| S1 / S-edge | `tool.execute.before(memory_remember)` gate; `tool.execute.after` capture |
| S2 | `tool.execute.after` (T1) + gate block |
| S3 | gate collapse on survivors |
| S4 / S4b-* | canonical-registry lookup + overlap/merge proposal |
| S5 | `tool.execute.before/after(memory_forget)`, snapshot dir, `deletions.logfmt` |
| S6 | `tool.execute.after` on the 4-check bash invocations (T4) |

> All S* scenarios ride deterministic hooks (tool.execute.before/after, the memory_* plugin tools, snapshots) — evidence is data, not chat; none auto-inject.

> DECISION 2026-09-17 — **scenario assertion contract = C** (user-chosen): a scenario PASS requires BOTH halves to hold — (1) **evidence-chain asserts** (data-path determinism: the memory write actually happened the way the gate sequence claims — ordered write-trace, no bypass, no missing gate-line), AND (2) **gate-coupled asserts** (behavior-fidelity: the pre-write chain for that write actually re-entered through the GATE seam — the FAIL→PASS retry-lock rode the gate, not a write that slipped around it). Neither alone is enough; C catches both "mechanism drift" (wrong data path) and "harness bypass" (right data, wrong seam). This is Prime-faithful: Prime's 30→95.5 attribution lives at the gate seam (same weights, different harness), so a scenario's PASS must demonstrate the write went THROUGH the gate, not just that a memory exists.

> DECISION 2026-09-17 — **scenario assertion = C (user-chosen, Prime-faithful both-halves)**: a scenario PASS/S1-S6 requires BOTH:
> (1) the **data path asserts** — the deterministic evidence-chain for the scenario's write is present, ordered, evidence-backed (e.g. for S1 the cautionary sequence `graph_current` → `ref_stale_scan{scope,found:n}` → `dedup_collapse|dedup_clean` → `write_promoted{evidence_ref}` with exactly the flags that should _not_ be present, and NOTHING indicating a write that masqueraded as chat), AND
> (2) the **gate-coupled behavior asserts** — the completion-gate FAIL→PASS (T4) that the scenario claims triggered the write actually re-entered through the /refine gate (the gate-coupled write-reroute that Prime's 30→95.5 attributes the win to) rather than writing directly around it.
>
> Since Prime's 95.5 attribution IS the gate-rewrite (same weights, harness proved the gate is where the observable change lives), a scenario designed purely against the data path would assert an artifact that any harness could construct without actually changing gate behavior — that's the Prime-faithless position. And a scenario purely against gate behavior would trust chat-shaped evidence an eager write could fabricate. C requires the data path to prove the write happened the claimed way, AND the gate to prove the system actually went through the harness seam. Both, not either; a scenario PASSes only if both assertions hold.

## Thesis

A harness/context engineering is a larger lever than raw model scale. Evidence:

- Prime Agent (Prime Intellect, open-source MIT, Aug 2026): same model weights, different harness → ARC-AGI-3 RHAE Best@1 30% → 95.5% (human-expert line 95.4%). Prime Intellect argues measurement pushed toward "model's true maximal encoding capability"; harness failure is not model failure.
- 2026 conventional wisdom shift: token/context efficiency + small regular rebases beats "bigger model"; local models closed the coding-agent gap within a year (0→90% in ~4 months: Gemma 4 26B-A4B, Qwen 3.5 35B-A3B); KV-cache compression/compaction research is the frontier (ReCache, SGD-KV, Random Attention, online compaction).
- Our stack already implements the durable-state-first approach: codebase-memory graph (CBM) + opencode-memory plus memory-inject auto-inject plugin + platform completion gate, all repo-hermetic, local, small-model.

## Non-negotiable principles (from user; MUST hold)

1. **Do not flood memories.** No unbounded growth; no duplicate/overlapping entries; inject cap; evidence vs durable-memory separation. Growth rate must be budgeted and review-gated.
2. **Combine like memories with canonical truth.** Merging/dedupe with canonical single source; contradictory or superseded entries collapse; canonical target named; evidence-backed.
3. **Human can prune a bad memory.** Deleting/forgetting must be possible, easy, auditable (reason + audit log), reversible via snapshot, and not repo-touching.
4. **Reflect and save memories when criteria met.** Deterministic triggers, not model-voluntary: failed→successful tool retry, compaction, key decisions, and completion-gate related lessons. Evidence-backed, not "just noticed something."

## Prime Agent → OpenCode mapping (what to build)

Prime Agent pillars (persistent IPython REPL = context-as-data; Continual Harness = typed versioned state; /refine = evidence-backed durable-state edits with snapshot+rollback; recursive subagents; daemon sessions) map to opencode as:

- **evidence store** (~/.config/opencode/memory/evidence/*.logfmt): deterministic capture of tool outcomes as data. Replaces "chat as results"; flood-free because not injected.
- **durable memory** (~/.config/opencode/memory/*.logfmt): typed curve (decision/learning/preference/blocker/context/pattern/…), injected via memory-inject plugin (auto-exists on our stack).
- **canonical truth**: AGENTS.md (repo and/or global) wins over memory on conflict; Prime"base system prompt immutable" analog — AGENTS.md/gate is immutable, memories are mutable.
- **/refine**: evidence-backed one-step durable-state update proposal, reviewable diff, snapshot, rollback (/undo), never auto-applies without review or explicit --yes. Mirrors Prime /refine/user review.
- **subagents/skills**: opencode skill files + subagent specs as durable, self-editable state (later phase; Prime "skills are data, not chat" — same for paths).

## Deterministic reflection triggers (Phase 1 mapping, hooks verified in installed SDK)

Use `tool.execute.before`/`tool.execute.after` (toolID/sessionID/callID, args, output{title,output,metadata}), `experimental.session.compacting`(input sessionID + output ctx), `chat.message` (sessionID). Evidence capture is deterministic: hook on tool results, not model decision.

Planned triggers (each writes evidence line; none auto-inject into chat):

- T1 **failed→fixed retry**: on tool.execute.after, if same tool+args failed previously then succeeded/不同 outcome-change, write learning evidence: {type: "learning"/"pattern", evidence} — this is the "handled knowledge" Prime Agent's refine uses.
- T2 **compaction/context-limit**: on experimental.session.compacting, snapshot/evidence digest of durable memory being dropped; Prime compares compaction = context engineering moment.
- T3 **key decisions**: tool.execute.after on specific tools (memory_add/update/forget, refine, ADR-ish, manage_adr, big file writes) captures evidence.
- T4 **completion gate**: verify_unit/verify_playwright/lint/tsc; on PASS after FAIL → learning "fix pattern".
All evidence lands in evidence/ (data, not chat). Only *promoted* learnings become durable memories via /refine.

## /refine loop (designed, not yet built)

Prime Agent /refine mechanics ported to our /refine:

1. **Read trajectory evidence** (tool.execute.after log) + recent memories.
2. **Propose ONE small evidence-backed update** to durable state: new memory (type=learning/pattern/decision) OR a memory merge/dedup proposal OR AGENTS.md one-line addendum OR skill/subagent-spec suggestion.
3. Each proposal = {evidence_ref(s), target, kind, before, after, reason} — a diff, possibly multi-hunk but small; snapshot of the pre-change state; one rollback unit.
4. **Human review gate** (Pop: two-phase): /refine proposes; user approves or edits or rejects. Auto-apply only for additive, low-risk ev-al (e.g. evidence capture itself) — never for AGENTS.md or harness/code changes, never for deletions unless user confirms.
5. **Apply + snapshot + rollback**: apply writes to memory/ or AGENTS.md via reversible snapshot dir; deletions logged with reason; /undo restores from snapshot; Prime" /undo" analog. Human can always prune (Principle 3) without code.

Dedup/merge mechanics (Principle 2):

- /refine merge step groups memories by (scope, type, content similarity), computes canonical content (evidence-backed), proposes replacing N entries with 1 canonical, keeps superseded entries as `merged_into=<new_ts>` markers (no data loss), and write evidence-backed. AGENTS.md conflict wins (canonical truth).
- Dedup rule: same scope+type+content → collapse; similar scope+type (Jaccard-ish) → propose merge in /refine; not auto.

## Trust boundary

- **Durable state** = memories + skills + subagent specs + AGENTS.md instructions. Memories: self-editable but evidence-gated. **Harness/code** (plugins, hooks, plugin files, AGENTS.md mechanics section) = immutable to the model by default; only human edits. Base system prompt immutable (Prime rule).
- **Target repo** is never touched by any of this (we are not its owner; keep it clean/zero-diff).
- Snapshot before every /refine apply; /undo restores; `/refine --yes` skips review only for additive low-risk, not for deletions/or harness.

## Build order (each phase review-gated)

- **Phase 1 — evidence capture (tool.execute.after → evidence logfmt)** + memory-inject remains pure storage no-behavior-change. Deterministic reflection triggers T1/T2/T3/T4 modeled on hooks. Zero risk; establishes Prime's "results as data" locally.
- **Phase 2 — /refine** (reflection + refine + review + snapshot/rollback) with dedup/merge gate (Principle 2) and human-prune (Principle 3). This is the Prime-like core.
- **Phase 3 — skills/subagent-spec promotion** (THE Skills as packages; Prime"skills executable"). Recurring patterns (test targeting, completion gate, grep→CBM routing) promoted to skill files.

## Dependencies/decisions

1. **Trust rule locked**: provider → /refine auto-applies only additive low-risk; everything else needs explicit review.
2. **Budget (Principle 1)**: memory inject capped (currently MAX_INJECT=10, memory-inject reads at session start); evidence separate from injected; promotion gate keeps growth budgeted.
3. Behavior change: opencode-memory writes plain logfmt but has NO built-in dedupe — needed for Principle 2 (merge/canonical) and Principle 3 (prune). World.
4. Prime Agent forensic discussion: Prime Agent 0.9 harness tracked (open in ARC-AGI-3) — we're replicating the /refine harness mechanics; same weights different harness.

## Open questions

- Does any of this require code changes to Prime Agent (Prime Agent base itself)? No — we limit to /refine core only. (Prime Agent itself: ARC-AGI research harness, not general agent core.)
- Compaction-based memory persistence (T2): what does autocompact/session.compacting メモリ propose? But only Prime Agent proved this; our plugin (memory injection) deterministic; /refine as Prime /refine, verified.
