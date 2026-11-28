# Surfaces

The terminal panel and chat report show session and shared-store statistics.
The browser editor manages the store directly. These surfaces make no model call.

## Terminal (opencode CLI)

The plugin ships a TUI half (`@opencode/plugin/tui`) that loads automatically.

- **Footer badge** — illustrative `● mem 1157/1200c · cache 96%`: the injected
  block against its budget, plus the measured session prompt-cache hit rate. The
  dot is green (stable and warm), yellow (recent recompute, or 50–90% reads) or
  red (last turn served almost nothing from cache); `—` until the first assistant
  turn, and `—` throughout on a provider that reports no cache usage.
- **`/memory`** — session panel: **CONTEXT** (what is riding the prompt now and
  how much of the budget it uses), **CACHE** (busts this session and the measured
  cache-served share of prompt tokens), **INJECTED BLOCK** (the verbatim block, or
  an explicit abstention), **RECENT BLOCKED WRITES** (with gate reasons), **STORE**
  (active / superseded / open / scopes, plus `malformed` when a row's `ts` is not
  a valid ISO instant — those rows are skipped by every reader). Keys: `r`
  refresh, `f` fullscreen.
- **Block toast** when a write is refused (`notifyBlocked: false` to silence).

## Desktop / web / IDE

The terminal slots do not exist there, so use the self-installed
**`/memory-report`** chat command: session and store sections rendered in the
conversation, plus the harness activity breakdown below. In other supported
harnesses, ask the agent to call `memory_status`.

## Combined and per-harness activity

`memory_status` and OpenCode's `/memory-report` include **HARNESS ACTIVITY**:

- Combined totals and separate rows for `opencode`, `oh-my-pi`, and any other
  adapter with retained telemetry.
- Credited injection, contextual pull, and recall events; blocked writes;
  completed capture calls, estimated capture tokens, captured rows, and capture
  lag percentiles. Each harness has its own latest capture configuration.
- Reported session tokens, keeping input, cache-read, cache-write, output, and
  reasoning separate when the host supplies that split. Missing usage is
  **not reported**, not zero. Without a reasoning split, output includes reasoning;
  a mixed aggregate cannot establish a complete answer/reasoning split.

The breakdown covers retained telemetry in the trailing thirty days. Retrieval
credits are throttled, and rotated or dropped records can reduce counts. These
are observed activity counts, not lifetime totals. Usage uses the latest retained
snapshot per harness/session; repeated snapshots are not added. A snapshot may
include work before the window, and older per-message sources only include
messages observed during that runtime. Capture token estimates remain separate
from provider-reported session tokens and exclude unreported reasoning.

Old records without a harness field count as **OpenCode**. New activity whose
source cannot be identified is explicitly **unknown**. No migration is needed.
STORE inventory remains shared: a memory does not belong to a harness, and one
memory recalled through two harnesses still counts as one stored memory. The
terminal `/memory` panel retains its session view; use `/memory-report` for this
breakdown.

## Browser editor

`bun memory-view`, then http://127.0.0.1:8787. Bound to loopback; requests are
checked against `Host` and `Origin`, so other hosts must be listed explicitly in
`OPENCODE_VIEWER_ALLOWED_HOSTS`. Listing a non-loopback host serves the store over
plain HTTP with no authentication — only do it on a network you control.
`OPENCODE_VIEWER_HOST` changes the bind interface.

The viewer is a trusted admin seat. Its edits and deleted-entry restores skip the
model-facing grounding and deduplication gates but honor the same value
rejections: [docs/internals/import-quarantine.md](../internals/import-quarantine.md).
