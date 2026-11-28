# ADR 0005 — Two-phase teardown for capture passes

Status: accepted (2026-11). Code: `src/runtime/capture.ts` (`PassPhase`, `DRAIN_LIMIT_MS`).

## Decision

A capture pass records the instant `generate.text` resolves (`pastModel`). Teardown treats the two phases differently:

- A pass PARKED in `generate.text` when the host disposes must never write — the caller may remove the store the moment cleanup resolves.
- A pass that already HOLDS its model answer drains, bounded by `DRAIN_LIMIT_MS` (1000 ms): the answer exists, the gate is milliseconds of local work.

## Why

One disposal signal conflated the two situations and the conflation killed the feature on the CLI. Aborting past-model passes is why most real `opencode run` passes recorded `capture_cost` and no row — 9 of 12 in one sample, 6 of 12 in a controlled A/B. The abort fired on the healthy path, in the only window capture is allowed to run. Past-model passes are bounded by the drain instead, which is what the drain is for.

## Related

- Passes in flight are tracked so teardown can stop them; a disposed-during-model-answer path drops the pass rather than writing into a store the caller may be removing.
- Reads that are awaited (known-rows list, transcript) are hoisted BEFORE the model call so the disposal check runs before them: each awaited read is its own window into a teardown.
- Evidence: issues #211 and #404.
