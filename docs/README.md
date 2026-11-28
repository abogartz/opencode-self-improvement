# Documentation index

Every document under `docs/`, with its audience and a one-sentence summary.
User-facing material lives in [`reference/`](reference/), maintainer evidence
and design notes in [`internals/`](internals/), and decision records in
[`adr/`](adr/). The [README](../README.md) holds the quick start; this file
is the map. A new document anywhere under `docs/` must gain a line below —
`test/doc-links.test.ts` fails the build when one does not.

## Using the plugin

- [Install variants and the version floor](reference/install.md) — users: the install
  paths beyond the README's three steps, how updates are resolved, and the
  supported version floor.
- [Options and environment variables](reference/options.md) — users: every knob in one
  place, including what an invalid value does.
- [Research flags](reference/flags.md) — users who want the why: the three flags that
  encode a measured finding rather than a preference, and the evidence behind
  each.
- [Surfaces](reference/surfaces.md) — users: the four ways to see the same data, all
  reading `memory_status` with no model call.
- [Troubleshooting, full list](reference/troubleshooting.md) — users: every problem and
  its fix, the common ones and the rarer ones.
- [Export, import, and moving a store between machines](internals/export-import.md) —
  users moving a store: the JSONL contract, and why you get what you can read.

## How it works, and what the measurements say

- [Auto-capture: what the evidence covers](internals/auto-capture-evidence.md) —
  maintainers: separates the three claims people confuse — the event fires,
  the write survives, the live store agrees.
- [Contradiction authority: the code check and its limits](internals/contradiction-authority.md) —
  maintainers: how the plugin decides when what you said and what the code
  says disagree.
- [Write gates and promotion evidence](internals/write-gates.md) — maintainers: how a
  memory claim is checked before it lands, the way a pull request is.
- [Repo scoping: identity, visibility and write refusal](internals/repo-scoping.md) —
  maintainers: the repository label on every row, checked on the way in and
  the way out.
- [Store concurrency, publication and permissions](internals/store-concurrency.md) —
  maintainers: replacing a store file while other sessions read it — a book
  swap, not a page rewrite.
- [Import, quarantine and the viewer's edit path](internals/import-quarantine.md) —
  maintainers: a quarantined row stays in the store, withheld from everything
  the model reads.
- [Secret redaction: what it covers and what it cannot](internals/secret-redaction.md) —
  maintainers: the best-effort credential rules and the limits of a metal
  detector.
- [The use ledger](internals/use-ledger.md) — maintainers: who looked at a row, when,
  and how it reached them.
- [Injection epochs and their measured cost](internals/injection-cost.md) —
  maintainers: how often the bytes in front of the model actually change, and
  what that costs.
- [Recall quality: what the keyword matcher gives up](internals/recall-quality.md) —
  maintainers: where word-overlap matching finds a memory and where it
  misses.
- [Write latency: one tree walk per write](internals/write-latency.md) — maintainers:
  why a write that cites code references scans the source tree once, not once
  per reference.

## Developing the plugin

- [Host interface and reference implementation](internals/host-contract.md) —
  adapter obligations, optional capabilities and the programmable test host.
- [OpenCode adapter parity review](internals/opencode-parity.md) — maintainers:
  preserved behavior, adapter boundaries, acceptance checks and known limits.

- [Development internals](internals/development.md) — contributors: what the local
  commands really run, what the smoke suite boots, and how the published npm
  surface is decided.
- [Pre-release ritual: mutation sweep and artifact policy](internals/pre-release-ritual.md) —
  release owners: break one claimed invariant on purpose and see whether
  anything notices.
- [Architecture decisions](adr/README.md) — everyone: the accepted designs,
  with status and supersession.
