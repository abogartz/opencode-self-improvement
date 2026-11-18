# The use ledger

A due-date card for every row: who looked at it, when, and how it reached them.
It answers one question you cannot answer any other way — is this memory
earning its place, or has nothing touched it in six months?

The ledger is `<memory-root>/hits.logfmt`: append-only, rotated at 2 MB, never
ingested as a memory, and reported in `memory_status` and the `/memory` panel.

## What counts as use

Credit comes from three distinct sources, because "the model asked" and "the
harness offered" are different facts:

1. the row rode the injected block;
2. `memory_recall` returned it;
3. a grep/read pull appended it.

Credit requires ≥2 shared terms with the query and is throttled to one line per
memory per session per source per hour, so one busy session cannot inflate a
row's standing.

**No prompt content is stored.** The ledger keeps a scan-truncated string from
the *memory* side, never your message.

## What use is allowed to do

Reinforcement is a tie-break only (`useBoost ≤ 1.0`): a recently used row wins a
tie and can never outrank a real score gap. In consolidation, the most recently
used member of a cluster is never the merge loser.

`never retrieved` is stated, not acted on. Pruning is your decision, and retired
rows cannot inherit reinforcement: ledger rows are verified against the store on
read.

## Whose numbers these are

Aggregate STORE counts are machine-wide by decision (#213 B): they count every
repository's rows in the shared store on this machine, never just the reading
session's repository. The numbers describe the store, not your slice of it.

Privacy applies to the content surfaces instead. `memory_evidence` and the
recent-blocked-writes list in `memory_status` and `/memory` follow each reader's
repository visibility (#306).

## Capture lag

Capture lag is how stale the newest message was when auto-capture fired. The
line prints only when at least one `capture_lag` sample exists, which needs
auto-capture to have fired.
