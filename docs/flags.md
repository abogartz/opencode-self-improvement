# Research flags

The three flags that encode a measured finding rather than a preference:
what each one enforces, the evidence behind it, and what an invalid value
does. The README's table gives the default and the effect.

`OPENCODE_MEMORY_SYMPTOM` is the clearest case. A lesson saved as "in this
session we fixed the flaky test" shares no words with the query a future
session types, so it gets filed and never found: measured, 0 of 8 diary-shaped
rows surfaced, against ranks 1–7 when the same lesson opens with the symptom.
The flag therefore refuses the diary form at the write gate instead of storing
something unrecoverable.

## Flag behaviour

| Variable | Full behaviour |
| --- | --- |
| `OPENCODE_MEMORY_DEDUP` | Near-duplicate suppression inside a `memory_recall` window. **ON by default at `0.8`** (content-token Jaccard): a row that is a near-copy (same scope, Jaccard at or above the threshold) of a row already returned is skipped — the newest copy of a clash survives — so the window fills with distinct facts instead of repeats of the top hit. Rows that disagree on a negation word, or carry too little comparable content, are never suppressed. Set `0` for the plain top-`limit` slice, byte-identical to the old behavior; an explicit value below `0.5` or above `1`, or one that is not a number, is a misconfiguration and turns the pass off; see [#409](https://github.com/abogartz/opencode-self-improvement/issues/409). |
| `OPENCODE_MEMORY_SYMPTOM` | Enforces the capture convention (#419): `learning` and `blocker` rows must open their content with the observable trigger a future session will hit, as `"When <symptom>: <fact>"`. A diary-shaped lesson ("In this session we fixed...") shares no words with the query the future session types — measured: surfaced 0/8 as diary, ranks 1-7 symptom-first — so the write gate blocks it with a rephrase hint instead of storing something that can never be recalled. ON by default; set `off` (or `0`/`false`) for automation holding a pre-convention backlog. A rewrite that keeps the supersede target's content byte-identical (a metadata-only `memory_update`, retag repair) is exempt — the rule shapes new lesson prose, not legacy-row maintenance. Other types (`context`, `decision`, `pattern`, `preference`) are unaffected. `scripts/symptom-fixer.ts` repairs old rows offline, grounding each symptom in the store's own query ledger. |
| `OPENCODE_MEMORY_QUERY_GATE` | **ON by default**: a `memory_recall` match must share **two** whole words of the query once the query has three content words — the rule the injected relevance block already applies, so both paths agree on when nothing is a good enough answer. Set `off` (also `0`, `no`, `n`, `false`, or any zero) to restore the matcher's permissive one-word admission. |
