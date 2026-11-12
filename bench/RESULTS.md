# Injection cost — measured

Reproduce with `bun bench/runners/inject-cost.ts` (deterministic: fixed-seed LCG,
synthetic timestamps, no wall clock in the output — reruns are byte-identical).
The numbers come from the plugin's real injection code (`src/inject.ts`):
a seeded store of 50 memories, a simulated session of
20 user prompts with 3 mid-session store writes, and the default
1200-character budget. The relevance block is budgeted by priority inside
the selector (`selectRelevant`, #388) and then rendered newest-first, so B/C/D
measure the shipped budget path and not a trim of the rendered string. Every
column is measured on the FULL memory section
(digest + frontier + relevance block) — the bytes a request actually sends,
because prompt caching is a property of those bytes and not of the block alone.

| Policy | Recomputes | Cache busts | Injected chars (20 turns) | Avg/turn | Worst section |
| --- | ---: | ---: | ---: | ---: | ---: |
| A — recompute per prompt, uncapped (naive) | 20 | 19 | 60996 | 3049.8 | 3404 |
| B — block frozen on store fingerprint, digest rebuilt per turn (pre-#162) | 4 | 3 | 55478 | 2773.9 | 2867 |
| C — section frozen on rendered bytes (pre-#165) | 4 | 3 | 55258 | 2762.9 | 2856 |
| D — C + riding bytes: the session's own additions are free (shipped) | 1 | 0 | 53500 | 2675.0 | 2675 |

A "cache bust" is a turn whose memory-section bytes differ from the turn
before: each one re-bills the whole conversation as fresh input.

The three mid-session writes are made BY the session being measured, which is
how memory actually gets written — the model saves what it just learned. All
three turn out to change what that session is shown (a new row shifts the
document frequencies and reorders the top-5), so B and C each pay 3
busts for them. D pays 0: a fact the session produced itself is
already in its transcript. What D still pays for is a riding row being corrected,
blocklisted or redacted, or another session writing a row — those survive the
subtraction and still land on the next request, pinned by `test/epoch.test.ts`.

D injects 12.3% fewer characters than the naive policy.

Compaction anchor (capped at 2500 chars): 2304 chars,
pushed once per compaction rather than per turn.
