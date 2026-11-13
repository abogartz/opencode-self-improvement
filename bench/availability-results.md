# Availability: tag vs delete — measured on one capture pass

16 rows written by the shipped capture path over 16 scripted candidates, 30 equal distractors, 21 dataset queries +6 doc queries. Verdicts from the shipped availabilityIndex; selection by the shipped selectRelevant with its real byte budget. Budgets are fractions of the unbudgeted block (2413 bytes).

## What each policy leaves in the store

| arm | rows | transport facts kept | restatable facts kept | model calls |
| --- | ---: | ---: | ---: | ---: |
| off | 17 | 10/10 | 6/6 | 1 |
| tag | 17 | 10/10 | 6/6 | 1 |
| delete-hardened | 11 | 10/10 | 0/6 | 1 |
| delete-original | 13 | 6/10 | 6/6 | 1 |

## What each budget shows

| budget | transport facts in block | restatable bytes in block | doc facts in block |
| ---: | ---: | ---: | ---: |
| 362 (15%) | 7 / 8 / 8 / 5 | 425 / 279 / 0 / 422 | 5 / 0 / 0 / 0 |
| 603 (25%) | 7 / 8 / 8 / 5 | 425 / 279 / 0 / 422 | 5 / 0 / 0 / 0 |
| 965 (40%) | 9 / 9 / 9 / 5 | 1002 / 1002 / 0 / 1002 | 6 / 0 / 0 / 0 |
| 1448 (60%) | 9 / 9 / 9 / 5 | 1002 / 1002 / 0 / 1286 | 6 / 0 / 0 / 6 |
| 2051 (85%) | 9 / 9 / 9 / 5 | 1424 / 1424 / 0 / 1870 | 6 / 6 / 0 / 6 |

Arms in every column: off / tag / delete-hardened / delete-original. The guided row is exempt from the demotion by design and rode 21/21 blocks at the loosest budget; the exemption control below measures it from the first budget that can physically hold the line, because at 15% the header plus the guided row exceeds the budget in every arm and that is arithmetic, not policy.

**Cost.** The tag arm answers 0,0,0,0,6 of 6 queries about facts the README also states, where the no-check arm answers 5,5,6,6,6. It gives up those slots at 15%, 25%, 40%, 60% budget — the demotion working as designed, because the tree has the fact, and a real loss all the same. At 85% the budget holds everything and the two arms agree.


The scan line reported 6 verdicts and 6 tagged rows; 0 of those verdicts landed on a candidate the write gate refused. The two fields are kept apart because a single number invites reading a verdict as a stored row.

## Controls

- PASS — negative control: a header-only budget puts 0 facts in the block (got 0) — a harness that cannot fail does not count
- PASS — no drop: the tag arm holds every row the no-check arm holds (17), of which 6 carry the tag — RED if any path in available.ts prevents a write
- PASS — the scan line separates its two numbers: verdicts=6 (candidates the check matched) vs restatements=6 (rows that carry the tag) — RED if a verdict the write gate refused is reported as a tagged row, or if either field drifts
- PASS — conservation: all 16 scripted candidates reached the store, RED with the lost prose named so the gate reason can be read off the trail
- PASS — the 362655c reproduction bites exactly its target population: 4/4 command-stating facts refused — RED if the reproduction drifts
- PASS — the bench can measure a loss: delete-original keeps 6/10 transport facts, the rest deleted before the write
- PASS — WIN vs the original rule: tag delivers 9/21 transport facts at the binding budget, delete-original 5, and tag is never behind at any budget (8,8,9,9,9 vs 5,5,5,5,5) — a deleted fact cannot be retrieved
- PASS — the demotion costs no recall: tag is at or above the no-check arm on transport facts at all 5 budgets (8,8,9,9,9 vs 7,7,9,9,9)
- PASS — WIN vs no check at all, stated honestly: the tag arm never spends MORE block bytes on facts the tree already states, at any budget, and spends fewer where the budget binds (279,279,1002,1002,1424 vs 425,425,1002,1002,1424)
- PASS — deleting is not free: the tag arm keeps 6 restatable facts a budget can still surface; #397's policy keeps 0, unreachable at any budget
- PASS — the guided lane is exempt: a guided AND restatable row still rides 21/21 blocks at every budget that can hold it (603, 965, 1448, 2051 bytes)
- PASS — one model call per pass whatever the policy — availability is decided after the call, so #389 AC4 cannot lower capture cost
- PASS — prompt containment: every scripted fact really rode the capture prompt

Scan cost for these 16 candidates: 3 files, 810 bytes, capped=false. A pass with no candidates builds the index never (test/capture-available.test.ts pins it).

Reproduce: `bun bench/runners/availability-policy-compare.ts`. Set `AVAIL_DUMP=1` to print the block for the first queries of each arm.
