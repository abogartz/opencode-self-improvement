# The use ledger

A due-date card for every row: who looked at it, when, and how it reached them.
It answers one question you cannot answer any other way — is this memory
earning its place, or has nothing touched it in six months?

The ledger is `<memory-root>/hits.logfmt`: append-only, rotated at 2 MB, never
ingested as a memory, and reported in `memory_status` and the `/memory` panel.

## What it looks like

Illustrative output — shape, not a measurement:

```
STORE
  41 active · 12 superseded · 4 open · 6 scopes
  retrieved 33 rows in the last 30d; never retrieved 8 (20%) — reported, not acted on
  outcome-linked 7 rides over 3 rows: 3 clean row/turns, 2 failed row/turns (store-wide)
  1 candidate at ≥5 rides with no clean turn — best-effort counts are floors since 2026-11-01T10:00:00.000Z; correlation on the ride's own turn, reported, never acted on
  outcome writes dropped for this store by this process: 0
    2026-10-31T14:05:00.000Z used=5 clean=0 fail_after=2 unknown=2 (eviction candidate)
  24.1 KB total · 604 B per row · 1.3 rows/day (30d)
```

## What counts as use

Credit comes from three distinct sources, because "the model asked" and "the
harness offered" are different facts:

1. the row rode the injected block;
2. `memory_recall` returned it;
3. a pull appended it to a grep/glob/read result — searched against that call's
   arguments plus the first 512 characters of what the tool printed, so a row can
   be credited here for something the model had not asked about yet
   (`pullOutputChars` in [docs/reference/options.md](../reference/options.md) dials it back).

A pull is credited when the next request carries it, not when it is placed.
Another plugin's `tool.execute.after` hook can run after this one and shorten the
result, so placing the block proves nothing about what the model receives
([#462](https://github.com/abogartz/opencode-self-improvement/issues/462)). The
plugin holds the placed rows until the next `session.context` request for the same
session. It matches the tool name, call ID and a fresh 16-character identifier
in the header. The rendering budget includes this identifier. A row earns credit
when its complete line survives after that placement’s header. If
several rows render to the same line and fewer copies survive, none of those row
IDs is credited, because the request cannot say which one rode. Each placement is
credited at most once. If a matching call ID occurs without the placement header,
the placement stays pending. A later request can confirm it. Expiry, eviction or
replacement records a single final loss for a placement that stayed unconfirmed.
When a formatter repeats a placement header within a result or the host repeats the result, each copy must independently contain enough matching lines to identify a row. If the process exits while a placement is pending, there is no final loss entry.
The ledger timestamp is the time of observation in the context hook.
A gate earlier in the tool batch therefore cannot count as following retrieval. The
hourly throttle and turn identity still come from placement. The `terms` come from
the query the pull searched.

The evidence log records placement and confirmation failures by tool and row count.
Ledger throttling, write failures, or process shutdown can also leave a row without
a receipt. Pull receipts share a 50 ms lock-wait budget per request, including
conversion of a legacy lock database on first use. A skipped
attempt after this budget expires emits `pull_credit_skipped reason=budget`.
A failed ledger write emits `pull_credit_skipped reason=write_failed` with the
placement’s scope and row count. A throttled duplicate produces neither event.
Lock acquisition uses a monotonic clock, including cold journal conversion.
On Windows, pull receipts attempt rotation once. A reader that prevents
replacement leaves the existing ledger intact. Filesystem I/O can still add latency.

- `pull_undelivered` (no `stage`): the pull computed rows and found nowhere to
  write them. A host that changes its result shape should show up as a failure,
  not as a quieter ledger.
- `pull_undelivered stage=request`: the request carried the placement header, but these rows
  were missing or cut.
- `pull_unconfirmed reason=expired|evicted|no_call|replaced`: no request settled the
  placement. Expiry is checked on later context activity, after 30 minutes. The
  256-placement cap also applies when there is no further context activity.
  Reusing a pending call ID in the same session retires the earlier placement.

The receipt checks the messages as this plugin's `session.context` hook sees them.
A context hook that another plugin runs later can still change the request, and
provider-side truncation is not visible. The credit is one step closer to the
provider than placement, but it is not the provider's own bytes. A pull that is
never followed by a request is not credited, so pull counts are a floor.

The writer throttles identical sets of retrieved rows to one successful line
per session and source per hour. A row can appear in multiple sets.

**No prompt content is stored.** The ledger keeps a scan-truncated string from
the *memory* side, never your message.

## What happens after retrieval

Each `memory_used` line records the turn number and turn key when available.
Each classified gate check appends a separate `ev=gate_outcome` line with
the session, turn, key, timestamp, command family and `outcome=clean|fail`.
The chat report aggregates those observations on read. On each row, `used`
counts recorded rides. `clean` and `fail_after` count distinct turns with
a classified gate after a ride. A later failure takes precedence over passes.
`unknown` counts rides without a usable later gate on that turn, including
legacy rides without a turn key when no compatible outcome exists.
Multiple rides on one turn can therefore contribute one measured turn.

The ledger drops old lines at rotation and can miss writes under contention.
The counts describe the retained observations. The dropped-outcome counter
covers failed writes in the reporting process for this store. It resets on
restart and excludes failures in other processes. A zero cannot establish
complete history.

A row becomes an eviction candidate after five recorded rides if at least
one ride has a measured outcome and none has a clean turn. A subsequent
failure can be unrelated to the row. Inspect the row and its use before
deciding whether to retire it. The report makes no store changes.

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

Outcome totals and candidate counts also cover every repository. The chat report
shows up to 20 reader-visible row IDs, prioritizing candidates. The omitted
count covers additional visible rows.

Privacy applies to the content surfaces instead. `memory_evidence` and the
recent-blocked-writes list in `memory_status` and `/memory` follow each reader's
repository visibility (#306).

## Capture lag

Capture lag is how stale the newest message was when auto-capture fired. The
line prints only when at least one `capture_lag` sample exists, which needs
auto-capture to have fired.
