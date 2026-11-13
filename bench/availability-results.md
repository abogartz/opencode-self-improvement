# Availability: tag vs delete — measured on one capture pass

15 rows written by the shipped capture path over 16 scripted candidates, 30 equal distractors, 21 dataset queries +6 doc queries. Verdicts from the shipped availabilityIndex; selection by the shipped selectRelevant with its real byte budget. Budgets are fractions of the unbudgeted block (2259 bytes).

## What each policy leaves in the store

| arm | rows | transport facts kept | restatable facts kept | model calls |
| --- | ---: | ---: | ---: | ---: |
| off | 16 | 10/10 | 5/5 | 1 |
| tag | 16 | 10/10 | 5/5 | 1 |
| delete-hardened | 11 | 10/10 | 0/5 | 1 |
| delete-original | 12 | 6/10 | 5/5 | 1 |

## What each budget shows

| budget | transport facts in block | restatable bytes in block | doc facts in block |
| ---: | ---: | ---: | ---: |
| 339 (15%) | 1 / 1 / 1 / 1 | 990 / 990 / 0 / 990 | 5 / 4 / 0 / 4 |
| 565 (25%) | 7 / 8 / 8 / 5 | 425 / 279 / 0 / 422 | 5 / 0 / 0 / 0 |
| 904 (40%) | 9 / 9 / 9 / 5 | 849 / 849 / 0 / 849 | 5 / 0 / 0 / 0 |
| 1355 (60%) | 9 / 9 / 9 / 5 | 987 / 987 / 0 / 1133 | 5 / 0 / 0 / 4 |
| 1920 (85%) | 9 / 9 / 9 / 5 | 1133 / 1133 / 0 / 1564 | 5 / 5 / 0 / 5 |

Arms in every column: off / tag / delete-hardened / delete-original. The guided row is exempt from the demotion by design and rode 0/21 blocks at the tightest budget.

## Controls

- PASS — negative control: a header-only budget puts 0 facts in the block (got 0) — a harness that cannot fail does not count
- PASS — no drop: the tag arm holds every row the no-check arm holds (16), of which 5 carry the tag — RED if any path in available.ts prevents a write
- PASS — the 362655c reproduction bites exactly its target population: 4/4 command-stating facts refused — RED if the reproduction drifts
- PASS — the bench can measure a loss: delete-original keeps 6/10 transport facts, the rest deleted before the write
- PASS — WIN vs the original rule: tag delivers 9/21 transport facts at the binding budget, delete-original 5, and tag is never behind at any budget (1,8,9,9,9 vs 1,5,5,5,5) — a deleted fact cannot be retrieved
- PASS — the demotion costs no recall: tag is at or above the no-check arm on transport facts at all 5 budgets (1,8,9,9,9 vs 1,7,9,9,9)
- PASS — WIN vs no check at all, stated honestly: the tag arm never spends MORE block bytes on facts the tree already states, at any budget, and spends fewer where the budget binds (990,279,849,987,1133 vs 990,425,849,987,1133)
- PASS — deleting is not free: the tag arm keeps 5 restatable facts a budget can still surface; #397's policy keeps 0, unreachable at any budget
- PASS — the guided lane is exempt: a guided AND restatable row still rides 21/21 blocks at every budget that can hold it (565, 904, 1355, 1920 bytes)
- PASS — one model call per pass whatever the policy — availability is decided after the call, so #389 AC4 cannot lower capture cost
- PASS — prompt containment: every scripted fact really rode the capture prompt

Scan cost for these 16 candidates: 2 files, 784 bytes, capped=false. A pass with no candidates builds the index never (test/capture-available.test.ts pins it).

Reproduce: `bun bench/runners/availability-policy-compare.ts`. Set `AVAIL_DUMP=1` to print the block for the first queries of each arm.
