# Write gates and promotion evidence

A memory is a claim about your code, so it is checked the way a pull request
is: does the reference resolve, is something already on file stale, is it a
duplicate, and does it land or come back with a reason. The four gates and the
undo contract stay in the README. This file is what the audit trail keeps, and
what an update carries with it.

## What promotion evidence samples

Promotion evidence keeps a bounded sample of call IDs: the ten most recent code-engagement calls, plus the latest gate check, the latest recorded gate FAIL/fix/PASS recovery, and the latest recorded tool FAIL/PASS retry (at most 16 distinct IDs). `evidence_refs_count` is the total number of recorded session calls before sampling, including non-code tools; the sampled IDs are audit pointers, not a complete history. Grounding and memory attribution still use the full in-memory ledger. Existing evidence day-files are left unchanged: this upgrade does not backfill, compact, or delete historical audit records.

## What an update carries forward

`memory_update` picks its row by `query`: the row's id, a clock fragment such as `00:11:22.123`, or a unique substring of its text. Omit it and the newest entry of that scope and type is the target. A query that matches nothing, or that matches several rows, writes nothing and says so — an ambiguous selector is never resolved by picking one.

A prose edit carries the previous row's ordinary tags, issue link, retrieval keywords, open/settled standing and repository forward to the new row, so updating a `global` row from one machine keeps it global for every other. Capture-only guidance provenance is stripped by the replacement: an ordinary edit cannot re-mint a `user-guided` tag or a contradiction verdict.

Naming a row that an earlier update already superseded reports the duplicate when the live successor already holds exactly that content. When only the metadata you named differs, the update runs against the successor instead of dead-ending.

If a failure happens after the new row is already durable, the reply says `PARTIAL`. The message names what failed, the replacement stands on disk, and `memory_undo` (merge or force) brings the old row back.
