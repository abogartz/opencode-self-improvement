# ADR 0009 — Availability verdicts refuse capture candidates, under the hardened matcher

Status: accepted (2026-11). Supersedes [ADR 0008](0008-availability-tags-not-refusals.md).
Code: `src/capture/available.ts` (the predicate), applied in `src/runtime/capture.ts` (the refusal).

## Decision

A capture candidate whose every assertion the working tree states verbatim —
modulo case, wrapping and markup — or whose only content is a command the
project's own gates declare, is REFUSED at capture time and logged on the
`auto_capture_restatable` evidence line, which names the file or the gate.
The figure-subset invariant bounds both paths: a refusal claims the passage it
cites states EVERY figure the candidate states, as whole tokens compared by
canonical value (`1.5`, `1.4.3`, `10.20.30.40` and `1,024` are single figures,
and `1,024` and `1024` are the same figure once the grouping comma is
dropped) — on the text path that passage is
the region the match covered, not the tree at large, since a figure in another
sentence is another sentence's business — and on the gate path the figures are
compared against the declared command, never against the candidate's own
spans. Contiguity bounds the text path: the claims must be found in the
candidate's order with nothing between one and the next but assertion
punctuation and whitespace, so a label from one line cannot be joined to a
value from another and the tree, not the session, owns every pairing it is
credited with stating. On the gate path the same relation asks about operands:
what a span adds to the command must be a contiguous token run in the
declaration that vouches for it — the script name and its command for a
per-script declaration, the matched step alone for a step-kind one — so the
bare invocation (empty operand) and a declared prefix stay refusals while
swapped values, stripped values and reorders keep their rows. Word membership
is not enough: `--target staging --fallback canary` declared against
`--target canary --fallback staging` has every word present and the pairing
wrong. One relation, both paths.

Atomicity is the spine, not another guard. A figure is one definition wherever
the matcher reads it: the figure grammar exported from `core/tokenize.ts` makes
a digit-bearing word run, where `.` and `,` belong to it only between digits —
`1.5`, `1.4.3` and `1,024` are single figures, and the `.` that ends a sentence
on one is prose, so `1.5.` states the figure `1.5` — therefore the claim
splitter never cuts inside a figure and a match is admitted only when no figure
run crosses either edge of it. Half-figures are what every earlier round
kept meeting from a different angle: a claim ending at the `3` of `3.12` is cut,
then re-tokenized by the region slice as a figure the tree never states. Judging
the boundary makes that shape unrepresentable rather than merely unvouched. The
subset, region and contiguity checks stay: they cost nothing on the fail-open
side and catch what atomicity cannot reach.

The refusal is scoped to the auto-capture path. `memory_remember`, updates,
imports and consolidation write what their callers ask for; a user may store a
restatement on purpose, capture may not. Capture refuses guided candidates on
the same terms: the recall layer's exemption of guided rows from the budget
demotion does not extend upstream, and a guided verbatim copy — refused, and
logged with `guided=true` so the decision stays visible — never becomes a row
that rides every injection block at full rank. Nothing is deleted from an
existing store, and the retrieval demotion of `restatable`-tagged rows stays
for rows written while the tag policy shipped.

## Why

ADR 0008 retired refusal because the rule of the day matched fragments: it
rejected 30 of 1,166 real captured rows and 29 of those refusals were wrong.
The matcher built during the tagging work is a different predicate — every
claim restatable, word-bounded, polarity-matched, warning-checked, no new
figure — and the policy bench measures it against the same alternatives: it
keeps 10 of 10 transport facts and refuses 6 of 6 restatable ones, where the
original rule destroyed 4 of 10 transport facts on a command mention alone.

The cost side then got a direct measurement. With one plausible wrong row in
the store, an agent shipped a wrong artifact in 4 of 5 runs; an empty store
failed honestly and invented nothing. A restatable row is the milder member of
that family — true, but redundant with a file the session can read — and the
store's only measured benefit (transport: empty store 0/5, seeded 5/5) comes
from facts the tree does not hold. At roughly a third of a session's own
generation per pass, budget spent on restatements buys nothing measurable.

## Consequences

- Capture writes fewer rows. Its model-call cost is unchanged — candidates
  come from the model, so the check can only run after the call — while the
  store and every later injection block shrink.
- The predicate fails open. No git, no repo, unreadable files, a capped scan,
  a dropped negation or a single new clause all keep the candidate. A wrong
  refusal costs a fact the next session cannot rebuild; a wrong keep costs one
  redundant row. The matcher's veto-only shape exists to keep the first rare.
- Refusal precedes the write gate, so a restatable candidate never becomes a
  supersession contender, and the gate's checks never see it. The refusal line
  carries the whole candidate, so a wrong refusal is replayable from the log.
- The `restatable` tag is no longer written by capture. `RESTATABLE_TAG`
  remains for legacy rows and for reserved-tag stripping; retiring it is a
  separate decision, taken once no tagged row survives in a store.
- Read-time dropping stays rejected: the row would still be written, and a
  wrong verdict would hide it with no refusal log naming the file.

## Evidence

`bench/availability-results.md` (the policy arms, including `delete-hardened`,
which is the shipped policy), `test/capture/capture-available.test.ts` (the
runtime consequence), `test/capture/availability-case-bank.test.ts` (every
adversarial verdict the matcher has been found guilty of), and the transport
and precision benchmarks reported on the epic.
