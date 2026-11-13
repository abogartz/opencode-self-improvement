# Availability: tag vs delete — measured on one capture pass

16 rows written by the shipped capture path over 16 scripted candidates, 180 seeded background rows in EVERY arm, 21 dataset queries +6 doc queries. Verdicts from the shipped availabilityIndex over captured and background rows alike; selection by the shipped selectRelevant with its real byte budget. `delete-original` replays the pinned `362655c` module, not an approximation of it. Budgets are fractions of the unbudgeted block (4608 bytes).

## What each policy leaves in the store

| arm | rows | transport facts kept | restatable facts kept | model calls |
| --- | ---: | ---: | ---: | ---: |
| off | 197 | 10/10 | 6/6 | 1 |
| tag | 197 | 10/10 | 6/6 | 1 |
| drop-at-read | 191 | 10/10 | 0/6 | 1 |
| delete-hardened | 191 | 10/10 | 0/6 | 1 |
| delete-original | 187 | 6/10 | 0/6 | 1 |

## What each budget shows

| budget | transport facts in block | restatable bytes per block (mean) | doc facts in block |
| ---: | ---: | ---: | ---: |
| 691 (15%) | 6 / 7 / 7 / 7 / 4 | 34 / 20 / 0 / 0 / 0 | 5 / 0 / 0 / 0 / 0 |
| 1152 (25%) | 8 / 8 / 8 / 8 / 4 | 41 / 41 / 0 / 0 / 0 | 6 / 0 / 0 / 0 / 0 |
| 1843 (40%) | 9 / 9 / 9 / 9 / 5 | 54 / 41 / 0 / 0 / 0 | 6 / 0 / 0 / 0 / 0 |
| 2765 (60%) | 9 / 9 / 9 / 9 / 5 | 89 / 48 / 0 / 0 / 0 | 6 / 0 / 0 / 0 / 0 |
| 3917 (85%) | 9 / 9 / 9 / 9 / 5 | 89 / 54 / 0 / 0 / 0 | 6 / 6 / 0 / 0 / 0 |

Arms in every column: off / tag / drop-at-read / delete-hardened / delete-original. The guided row is exempt from the demotion by design and rode 21/21 blocks at the loosest budget; the exemption control below measures it from the first budget that can physically hold the line, because at 15% the header plus the guided row exceeds the budget in every arm and that is arithmetic, not policy.

**Ceiling.** 14 of 21 transport queries retrieve their own gold when that gold is the ONLY row in the store, and 6 of 6 doc queries do. Every recall figure above is out of those ceilings, not out of 21: the best arm reaches 9/14 retrievable, which is a different claim from 9/21. 7 curated pairs never retrieve their gold even with no competition at all (m01, m02, m04, m07, m08, m12, m14); that is a scorer/dataset finding, reported here and not this bench's to fix.


**Cost.** The tag arm answers 0,0,0,0,6 of 6 queries about facts the README also states, where the no-check arm answers 5,6,6,6,6. It gives up those slots at 15%, 25%, 40%, 60% budget — the demotion working as designed, because the tree has the fact, and a real loss all the same. At 85% the budget holds everything and the two arms agree.

**Where the tag lands.** 6 of 16 rows this pass wrote carry it (38%), against 0 of 180 rows already in the store when the pass ran (0%). That 0 is a property of this fixture, not of the check: 0 of the 180 seeded rows quote a sentence of the tracked tree, so there was nothing there for the check to find. No real-world base rate is claimed — that needs a store written in the same repo it is read from. What is established is the direction the tag asserts: all 6 marked rows share substantive words with the tracked tree, which the control below re-checks every run.

## Does the win survive a different store size?

Same 16 captured rows, background resampled at 0/30/90/180 rows; budget recomputed per size (2413/2791/3479/4608 bytes unbudgeted), shown at 25%, 40%, 60%. Transport facts in block.

| background | off | tag | drop-at-read | delete-hardened | delete-original |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 7/9/9 | 8/9/9 | 8/9/9 | 8/9/9 | 5/5/5 |
| 30 | 7/9/9 | 8/9/9 | 8/9/9 | 8/9/9 | 5/5/5 |
| 90 | 7/9/9 | 7/9/9 | 7/9/9 | 7/9/9 | 4/5/5 |
| 180 | 8/9/9 | 8/9/9 | 8/9/9 | 8/9/9 | 4/5/5 |

## Case bank: every adversarial verdict, re-decided

23 (tree, candidate) pairs, one repo each, decided by the shipped availabilityIndex. 7 must tag, 16 must not.

| case | expect | got | found by |
| --- | --- | --- | --- |
| nowhere-in-tree | keep | keep | #389 — a fact the tree does not state is the one the store exists for |
| verbatim-restatement | tag | in_tracked_file | #389 — the rule's only true positive |
| formatting-is-not-a-new-fact | tag | in_tracked_file | #397 — case, backticks and wrapping are formatting |
| negation-dropped | keep | keep | #397 round 3 (WhollyMindless) — the worst failure this check can have |
| negation-kept | tag | in_tracked_file | #397 round 3 — the guard did not simply switch the check off |
| word-boundary | keep | keep | #397 round 3 — `use tabs` is not a hit inside `abuse tabs` |
| stop-assuming | keep | keep | #403 review (4568409650) — reopened by narrowing the polarity equality |
| drop-the-assumption | keep | keep | #403 review (4568409650) — second shape, same family |
| never-assume | keep | keep | #403 review — the cue-list path of the same family |
| deterrent-verb-not-governing | tag | in_tracked_file | #403 self-review — the veto's own over-decline, caught by this case |
| ordinary-verb-not-a-deterrent | tag | in_tracked_file | #403 self-review — `drops` governs `stale entries`, not a following claim |
| new-clause-rides-restatement | keep | keep | #397 review — matching PART of a candidate does not establish the WHOLE fact |
| new-number-on-declared-command | keep | keep | #402 veto 2 — a changed figure is a different fact, not a rephrasing |
| restriction-on-declared-command | keep | keep | #397 round 3 — the restriction and the code appear nowhere |
| short-restriction-on-declared-command | keep | keep | #397 round 2 — a short residual is not a restatement |
| second-command-not-swallowed | keep | keep | #397 round 4 — every command span was stripped after ONE declared gate |
| prohibition-on-declared-command | keep | keep | #397 — a sentence that states a command may also forbid it |
| declared-command-restated | tag | in_tracked_file | #389 — the declared-gate rule's true positive, backticks aside |
| declared-command-reworded-residual | keep | keep | #397 round 4 — the residual is checked too, and a reworded residual is kept |
| prose-command-not-a-code-span | keep | keep | self-review of the case bank — the command check reads code spans only, so a prose command is not a match; recorded as a limit, not fixed |
| prose-restatement-still-tags | tag | in_tracked_file | self-review of the case bank — the counterpart to the prose-command limit above |
| declared-command-new-context | keep | keep | #397 round 2 — the manifest states the command, not when to use it |
| gate-name-in-prose | keep | keep | #397 review — a short gate name does not tag prose that merely contains it |


The scan line reported 6 verdicts and 6 tagged rows; 0 of those verdicts landed on a candidate the write gate refused. The two fields are kept apart because a single number invites reading a verdict as a stored row.

## Controls

- PASS — the background really competes: the 180 seeded rows plus the guided control are the identical set in every storage arm (sizes 197/197/191/191/187 — drop-at-read is smaller on purpose, it filters at read time) — RED if a filter drops them again
- PASS — the pinned baseline is the real module — RED if the fixture was edited away from 362655c
- PASS — negative control: a header-only budget puts 0 facts in the block (got 0) — a harness that cannot fail does not count
- PASS — no drop: the tag arm holds every row the no-check arm holds (197), of which 6 carry the tag — RED if any path in available.ts prevents a write
- PASS — the scan line separates its two numbers: verdicts=6 (candidates the check matched) vs restatements=6 (rows that carry the tag) — RED if a verdict the write gate refused is reported as a tagged row, or if either field drifts
- PASS — conservation: all 16 scripted candidates reached the store, RED with the lost prose named so the gate reason can be read off the trail
- PASS — the baseline is the historical rule, not a stand-in: the pinned 362655c module refuses 10 of 16 captured rows, including every documented fact and all 4 command-stating ones — RED if the vendored module drifts or a hand-written approximation creeps back
- PASS — the bench can measure a loss: delete-original keeps 6/10 transport facts, the rest deleted before the write
- PASS — WIN vs the original rule: tag delivers 9/14 retrievable transport facts (21 asked) at the binding budget, delete-original 5, and tag is never behind at any budget (7,8,9,9,9 vs 4,4,5,5,5) — a deleted fact cannot be retrieved
- PASS — the demotion costs no recall: tag is at or above the no-check arm on transport facts at all 5 budgets (7,8,9,9,9 vs 6,8,9,9,9)
- PASS — WIN vs no check at all, stated honestly: the tag arm never spends MORE block bytes on facts the tree already states, at any budget, and spends fewer where the budget binds (20,41,41,48,54 vs 34,41,54,89,89)
- PASS — deleting is not free: the tag arm keeps 6 captured restatable facts a budget can still surface; #397's policy keeps 0, unreachable at any budget
- PASS — the guided lane is exempt: a guided AND restatable row still rides 21/21 blocks at every budget that can hold it (691, 1152, 1843, 2765, 3917 bytes)
- PASS — one model call per pass whatever the policy — availability is decided after the call, so #389 AC4 cannot lower capture cost
- PASS — prompt containment: every scripted fact really rode the capture prompt
- PASS — the case bank can say both things: 23 cases, 7 must tag and 16 must not — RED if either polarity is emptied out
- PASS — the shipped matcher still decides every adversarial case: 23/23 — RED with the case named, so the veto that moved is readable from its "found by" column
- PASS — a read-time drop removes exactly the restatable rows and nothing else: it keeps 10/10 transport facts and 191 of 197 rows — RED if a verdict is read from the wrong row, which is what a ts-keyed lookup does when a pass writes rows in one millisecond
- PASS — the hit metric can score at all: 14/21 transport and 6/6 doc queries retrieve their own gold alone — unretrievable golds: m01, m02, m04, m07, m08, m12, m14 — RED if a family goes wholly blind, because a wholly blind family reports 0 in every arm and no other control would notice
- PASS — every marked row is supported by the tracked tree: 6 marked of 196 rows, 0 with no substantive word in common — RED if a row is marked on nothing, or if nothing is marked at all
- PASS — the win is not an artefact of one store size: tag is at or above both delete-original and drop-at-read on transport facts at all 4 background sizes x 3 budgets (0:8/9/9 30:8/9/9 90:7/9/9 180:8/9/9)
- PASS — the P3 preview does what it claims: drop-at-read spends 0 block bytes on facts the tree states at every budget — and the transport column is the price (7,8,9,9,9 vs tag 7,8,9,9,9)

Scan cost for these 16 candidates: 3 files, 810 bytes, capped=false. A pass with no candidates builds the index never (test/capture-available.test.ts pins it).

Reproduce: `bun bench/runners/availability-policy-compare.ts`. Set `AVAIL_DUMP=1` to print the block for the first queries of each arm.
