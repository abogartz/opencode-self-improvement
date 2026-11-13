# Availability: tag vs delete — measured on one capture pass

16 rows written by the shipped capture path over 16 scripted candidates, 30 seeded background rows in EVERY arm, 21 dataset queries +6 doc queries. Verdicts from the shipped availabilityIndex over captured and background rows alike; selection by the shipped selectRelevant with its real byte budget. `delete-original` replays the pinned `362655c` module, not an approximation of it. Budgets are fractions of the unbudgeted block (2791 bytes).

## What each policy leaves in the store

| arm | rows | transport facts kept | restatable facts kept | model calls |
| --- | ---: | ---: | ---: | ---: |
| off | 47 | 10/10 | 6/6 | 1 |
| tag | 47 | 10/10 | 6/6 | 1 |
| delete-hardened | 41 | 10/10 | 0/6 | 1 |
| delete-original | 37 | 6/10 | 0/6 | 1 |

## What each budget shows

| budget | transport facts in block | restatable bytes in block | doc facts in block |
| ---: | ---: | ---: | ---: |
| 419 (15%) | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| 698 (25%) | 7 / 8 / 8 / 5 | 1000 / 713 / 0 / 0 | 6 / 0 / 0 / 0 |
| 1116 (40%) | 9 / 9 / 9 / 5 | 1002 / 1002 / 0 / 0 | 6 / 0 / 0 / 0 |
| 1675 (60%) | 9 / 9 / 9 / 5 | 1002 / 1002 / 0 / 0 | 6 / 0 / 0 / 0 |
| 2372 (85%) | 9 / 9 / 9 / 5 | 1717 / 1424 / 0 / 0 | 6 / 6 / 0 / 0 |

Arms in every column: off / tag / delete-hardened / delete-original. The guided row is exempt from the demotion by design and rode 21/21 blocks at the loosest budget; the exemption control below measures it from the first budget that can physically hold the line, because at 15% the header plus the guided row exceeds the budget in every arm and that is arithmetic, not policy.

**Cost.** The tag arm answers 0,0,0,0,6 of 6 queries about facts the README also states, where the no-check arm answers 0,6,6,6,6. It gives up those slots at 25%, 40%, 60% budget — the demotion working as designed, because the tree has the fact, and a real loss all the same. At 85% the budget holds everything and the two arms agree.


The scan line reported 6 verdicts and 6 tagged rows; 0 of those verdicts landed on a candidate the write gate refused. The two fields are kept apart because a single number invites reading a verdict as a stored row.

## Controls

- PASS — the background really competes: the 30 seeded rows plus the guided control are the identical set in every arm (sizes 47/47/41/37, differing only by captured rows the policy deletes) — RED if a filter drops them again
- PASS — the pinned baseline is the real module — RED if the fixture was edited away from 362655c
- PASS — negative control: a header-only budget puts 0 facts in the block (got 0) — a harness that cannot fail does not count
- PASS — no drop: the tag arm holds every row the no-check arm holds (47), of which 6 carry the tag — RED if any path in available.ts prevents a write
- PASS — the scan line separates its two numbers: verdicts=6 (candidates the check matched) vs restatements=6 (rows that carry the tag) — RED if a verdict the write gate refused is reported as a tagged row, or if either field drifts
- PASS — conservation: all 16 scripted candidates reached the store, RED with the lost prose named so the gate reason can be read off the trail
- PASS — the baseline is the historical rule, not a stand-in: the pinned 362655c module refuses 10 of 16 captured rows, including every documented fact and all 4 command-stating ones — RED if the vendored module drifts or a hand-written approximation creeps back
- PASS — the bench can measure a loss: delete-original keeps 6/10 transport facts, the rest deleted before the write
- PASS — WIN vs the original rule: tag delivers 9/21 transport facts at the binding budget, delete-original 5, and tag is never behind at any budget (0,8,9,9,9 vs 0,5,5,5,5) — a deleted fact cannot be retrieved
- PASS — the demotion costs no recall: tag is at or above the no-check arm on transport facts at all 5 budgets (0,8,9,9,9 vs 0,7,9,9,9)
- PASS — WIN vs no check at all, stated honestly: the tag arm never spends MORE block bytes on facts the tree already states, at any budget, and spends fewer where the budget binds (0,713,1002,1002,1424 vs 0,1000,1002,1002,1717)
- PASS — deleting is not free: the tag arm keeps 6 captured restatable facts a budget can still surface; #397's policy keeps 0, unreachable at any budget
- PASS — the guided lane is exempt: a guided AND restatable row still rides 21/21 blocks at every budget that can hold it (419, 698, 1116, 1675, 2372 bytes)
- PASS — one model call per pass whatever the policy — availability is decided after the call, so #389 AC4 cannot lower capture cost
- PASS — prompt containment: every scripted fact really rode the capture prompt

Scan cost for these 16 candidates: 3 files, 810 bytes, capped=false. A pass with no candidates builds the index never (test/capture-available.test.ts pins it).

Reproduce: `bun bench/runners/availability-policy-compare.ts`. Set `AVAIL_DUMP=1` to print the block for the first queries of each arm.
