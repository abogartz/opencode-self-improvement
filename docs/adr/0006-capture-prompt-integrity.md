# ADR 0006 — Capture prompt integrity: redaction order and faithful citation

Status: accepted (2026-11). Code: `src/runtime/capture.ts`, `buildCapturePrompt`.

## Decisions

1. Redact the COMPLETE transcript, THEN apply the character budget. Cropping first can start the window INSIDE a credential: a PEM body whose BEGIN marker fell off, or a token whose prefix fell off, matches no pattern, and the prompt builder's own scrub (kept, defense in depth) cannot recognize a fragment.
2. Ledger failure entries are redacted AT CONSTRUCTION. Ledger args are raw tool input: a failing `bun test --token=sk-...` put the credential verbatim into the ATTESTED FAILURES block — the transcript scrub does not cover this input. Redacting at construction makes the prompt render the safe string AND the citation check compare against the same representation the model was shown.
3. A lesson citation must copy a COMPLETE displayed field. Substring presence cannot establish that a cited command ran: `includes("tsc")` accepted a lesson citing `tsc` when the only failure was `bun test --test-name-pattern tsc`. The list renders `cmd — arg`; membership is tested against each whole entry, its cmd, and its arg — never a fragment. The cmd-only citation the prompt's own example uses still passes.
4. The mined transcript is partitioned so the user's brief is labelled as the brief instead of blending into the evidence; the single un-partitioned block is the fallback when the work lines alone are too thin (a seeded transcript with no message array behind it), which keeps the old prompt shape rather than silently dropping the prose.
5. The user's turns are decoded from the message array rather than read back out of rendered text. Everything that vouches for "these are the user's own words" goes through that decode.

## Evidence

Review findings on issues #384 and #364; the credential-cropping window from #132.
