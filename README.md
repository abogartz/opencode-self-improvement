# Opencode-Self-Improvement

Durable memory for [opencode](https://opencode.ai): the decisions, commands and facts an agent should still know next week, plus a one-command per-repo setup.

Say "we use Bun, not npm — npm keeps breaking the lockfile" on Monday. A session you start on Tuesday already knows it, and why. A memory that turns out wrong is superseded, never deleted, and `memory_undo` rolls it back.

Every figure here carries a marker: **measured** (read off a live store), **bench** (a deterministic synthetic workload, reproducible with the command printed under the table), or **illustrative** (sample output showing shape, not a measurement). A number without a marker is a claim that has not been checked.

## Quick start

**1. Add the plugin** to `~/.config/opencode/opencode.jsonc` (global) or a project `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-self-improvement"]
}
```

**2. Restart opencode.** On the desktop app a later config edit needs `opencode service restart`: relaunching the app leaves the background service, and the options it already parsed, alive.

**3. Run `/repo-init`** in each repo you work in. It stores that repo's test / build / lint / typecheck commands as memories, so the next session does not rediscover them. Rerun `/repo-init force` after a refactor.

After that, memory is just conversation: ask the agent to remember something and it sticks.

<details>
<summary>Other ways to install, and the version floor</summary>

```sh
opencode plugin add opencode-self-improvement
opencode plugin update opencode-self-improvement
```

Needs Bun 1.3.0 or newer in the opencode build (the tested floor); older Bun reports a startup warning.

An unpinned entry resolves `@latest` exactly once and is never re-resolved afterwards, so updates are deliberate: run `opencode plugin update` when you want one. To pin, append `@<version>` — see [npm](https://www.npmjs.com/package/opencode-self-improvement) for what is current.

To work on the plugin instead, clone it and point the entry at the checkout:

```sh
git clone https://github.com/abogartz/opencode-self-improvement.git
cd opencode-self-improvement && bun install
```

```json
{ "plugins": ["/full/path/to/opencode-self-improvement/index.ts"] }
```

Then `git pull` and restart opencode to update.

</details>

## What you get

Think of it as a lab notebook the agent keeps for your repo, plus a librarian who checks every entry before filing it.

- **Write gates — a CI check for facts.** A memory citing `parseHeader()` in a file you deleted is refused before it is stored, not after a future session trusts it. Near-duplicates collapse, and a contradiction with a retired memory is rejected. Every refusal lands in `memory_evidence` with its reason.
- **Budgeted injection.** Relevant memories ride the prompt on their own, capped at `injectBudget` characters. The block is cache-stable: a write somewhere else in the store does not cost you a cache miss.
- **Repo scoping.** Every row carries the repo that wrote it, so project A's facts never surface in project B. A preference you want everywhere goes in with `memory_remember global: true`.
- **Nothing is deleted.** `memory_update` supersedes the old row, `memory_forget` records a retirement, `memory_undo` restores a snapshot.
- **Memory-aware compaction** — a long session hands its durable facts to the summarizer instead of losing them.
- **Safe across concurrent sessions** — a reader sees the previous store file or the new one, never half of either.
- **Decay and consolidation** — `memory_decay` retires stale open threads, `memory_consolidate` proposes near-duplicate merges. Both are dry-run-first and write nothing you did not approve.
- **Export / import (JSONL)** — back the store up or move it between machines; every imported row re-enters through the same gates.
- **Surfaces** — a footer badge, the `/memory` panel, `/memory-report` for chat clients, and a browser admin editor. See [Surfaces](#surfaces).
- **Secret redaction** — credential-shaped values become `[redacted]`. See [Secret redaction](#secret-redaction).
- **`memory_*` tools** — `memory_remember`, `memory_recall`, `memory_update`, `memory_forget`, `memory_undo`, `memory_status`, `memory_evidence`, `memory_export`, `memory_import`, `memory_decay`, `memory_consolidate`, `memory_merge_review`, `memory_list`, `memory_init`.
- **Auto-capture (opt-in)** — at the end of a turn, and again at compaction, one cheap model pass reads what just happened and proposes facts worth keeping. They face the same write gates as anything you save by hand. Off by default, so a plain install makes no extra model calls. See [Auto-capture](#auto-capture).

Memory is stored outside every repository, under `~/.config/opencode/memory` by default (override with `OPENCODE_MEMORY_DIR`). To start over, delete that directory.

## Options

Zero configuration is the default. Two options change what the model sees:

| Option | Default | What it does |
| --- | --- | --- |
| `injectBudget` | `1200` | Character cap on the injected relevance block and each contextual pull. |
| `frontierBudget` | `3 × injectBudget` | Character cap on the session-start open-threads block. A thread longer than the budget is not injected and is reported as omitted. |

Anything else goes in the object form of the plugin entry in `opencode.json(c)`:

```json
{
  "plugins": [{ "package": "opencode-self-improvement", "options": { "injectBudget": 1200, "frontierBudget": 3600 } }]
}
```

The capture options (`autoCapture`, `captureModel`, `captureMax`, `captureOnCompact`, `captureGuidedRules`) are described where the feature is: [Auto-capture](#auto-capture). `contradictionSurface` is described with the verdict table in [Contradiction authority policy](#contradiction-authority-policy-experimental-349--351). Every option and environment variable, including what an invalid value does: [docs/options.md](docs/options.md) — and read [docs/flags.md](docs/flags.md) before flipping `OPENCODE_MEMORY_DEDUP`, `OPENCODE_MEMORY_SYMPTOM` or `OPENCODE_MEMORY_QUERY_GATE`, because each one switches off behaviour a measurement decided.

## Auto-capture

Auto-capture is the part that notices facts on its own instead of waiting to be asked. At the end of a turn — and again at compaction, before the summarizer replaces the transcript — one cheap model pass reads what just happened and proposes up to `captureMax` candidates. They face the same four write gates as anything you save by hand, and a 5-minute cooldown per session and trigger bounds the spend.

It is **off by default**, so a plain install makes no extra model call. To turn it on you must also name the model it may use:

```json
{
  "plugins": [{ "package": "opencode-self-improvement", "options": { "autoCapture": true, "captureModel": "provider/id" } }]
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `autoCapture` | `false` | Master switch. Off, so a plain install makes no extra model call. |
| `captureModel` | — | `"provider/id"` model for the pass. Required when capture is on; missing or invalid disables capture with a startup warning. |
| `captureMax` | `3` | Maximum candidates proposed per pass. |
| `captureOnCompact` | `true` | Also mine the transcript at compaction. Its 5-minute cooldown is separate from the turn-end one, so both triggers' hit-rates stay measurable. Setting it while `autoCapture` is off does nothing. |
| `captureGuidedRules` | `false` | POC: a deterministic pre-pass marks the values and rules you stated outright — numbers, rates, currency, explicit rule assertions — and attaches your verbatim quote. The capture model may rephrase such a row but cannot clear the flag or invent the quote: a quote you never wrote is refused at the write boundary rather than stripped silently. No extra model calls. |

**The honest caveat.** The trigger fires and the write survives on a real host: `e2e/capture.test.ts` drives `opencode run` and a capture pass starts in 12 of 12 runs. What has not been seen is a live store completing a pass — no `auto_capture_*` line exists anywhere in the maintainer's evidence history — and nothing about quality is measured: what auto-capture would write, how often it duplicates a memory you would have written yourself, and what it costs. So switch it on to try it, not because it is known to pay.

What has been established, and by which kind of evidence, is itemised in [docs/auto-capture-evidence.md](docs/auto-capture-evidence.md). Read that file before quoting any figure in it — two of the entries are defects found in the measuring bench itself, and the corrected numbers are the ones recorded there. `bench/capture-trigger-results.md` is a **bench** simulation of trigger *timing* with a scripted extractor; it answers "which moment is worth mining", not "does this earn its keep".

**Am I armed?** `memory_evidence` answers on the `plugin_load` line: `capture=off` (the option is not on), `invalid_model` (`captureModel` is not `provider/id`), `no_capabilities` (the host did not expose what capture needs) or `capture=on`, next to `subscribed=[…]` listing the event types that subscription really reacts to. On desktop this needs `opencode service restart` after an edit — relaunching the app keeps the old service and its already-parsed options alive, so `capture=` can report a value your config no longer contains. `capture=on` plus no `auto_capture_*` line after a session means the pass did not complete, not that your configuration is wrong; #404 found that mechanism and its fix is merged.

## How memory is written

A memory is a claim about your code, so it gets checked like one. Four gates run before anything is stored, and each emits an ordered evidence line:

1. **GATE-1 — code references resolve.** Call signatures and paths embedded in the memory are checked against your live source tree.
2. **GATE-2 — no stale memory applies here.** References that drifted out of date are superseded or the write is blocked.
3. **GATE-3 — no duplicates.** Near-duplicates collapse into the existing row; a contradiction with a superseded memory is rejected.
4. **GATE-4 — promotion or block.** The row lands, or the call returns the reason.

Nothing is deleted. `memory_update` supersedes the old row and `memory_forget` records a retirement, so history stays readable, and `memory_undo` restores a snapshot when a change turns out wrong. `memory_update` picks its row by `query` — an id, a clock fragment such as `00:11:22.123`, or a unique substring of its text — and a query that matches nothing, or several rows, writes nothing and says so. What carries over to the new row, what a `PARTIAL` reply means for the rows on disk, and what promotion evidence samples: [docs/write-gates.md](docs/write-gates.md).

### Contradiction authority policy (experimental, #349 / #351)

You and the code disagree about a constant. Who is right depends on what you said, so capture records the kind of statement:

| Captured statement | Class | Verdict on a detected conflict |
| --- | --- | --- |
| User states the required value for a declared constant | `spec` | The user is the authority; change the constant to the stated requirement. |
| User describes how working code behaves | `behavior` | Code is the authority; keep the constant and raise the mismatch with the user. |
| Authority is unclear | Omit `klass` | Keep plain guidance and its staleness caveat; emit no CONFLICT verdict. |

The code check accepts only a unique top-level `const` with a literal value, runs inside fixed source budgets, and refuses to decide anything it cannot read. Its limits, and the accepted residual — a user-stated **wrong spec** still classifies as `spec` and its verdict follows that requirement — are in [docs/contradiction-authority.md](docs/contradiction-authority.md).

## Repo scoping

Rows are stamped with your git origin (an id that survives re-clones and moves between machines) or, without an origin, a hash of the normalized directory path. `repoPath` keeps the human-readable path, so rows written before hashing keep matching.

Reads — injection, recall, the frontier block, compaction, `memory_forget` and decay — see the current repo plus global rows. Writes follow the stricter direction: a named session whose repository cannot be resolved has **no write target**, so `memory_remember`, `memory_update`, `memory_import` and auto-capture refuse it (evidence `write_refused`) rather than stamp your content into another workspace or publish it as an unstamped row. Preferences that should follow you everywhere go in with `memory_remember global: true`.

Identity derivation and legacy hashes, evidence attribution when a session moves repositories mid-operation, and the viewer's separate admin seat: [docs/repo-scoping.md](docs/repo-scoping.md).

## What memory is worth, measured

Two results. Only two are quoted, each with its `n` and the seat it ran on, because the direction of an early finding flipped when the metric was corrected — see [#385](https://github.com/abogartz/opencode-self-improvement/issues/385) and [#392](https://github.com/abogartz/opencode-self-improvement/issues/392).

**The metric.** `work = session generation + capture generation`, with cache read and cache write reported separately and never folded into a total. Capture is a separate model call made after the turn, so it appears in no session's usage: a meter that reads session numbers alone reports this plugin's own cost as exactly zero. On the seat below `input` is only the **uncached remainder** — one run reported 13,393 of 187,856 tokens that actually moved, 7%.

| Result | n | Seat | What was measured |
| --- | --- | --- | --- |
| **Transport.** A fact learned in one session reaches a later session that provably cannot obtain it any other way | 5 per arm, with the empty-store floor verified first | `evo/Qwen3.8-Flash-Next-UD-Q4_K_XL`, local seat behind a recording proxy | empty store **0/5** (every failure: the artifact was never written), the same store seeded **5/5**. The fixture is leak-checked: no form of the answer is in any file the agent sees, including its own documentation |
| **Reuse.** A memory reduces the work on a task the agent already passes | 6 pairs | same seat | median of the six per-pair L2/L0 work ratios — sorted 0.54, 0.79, 0.84, 0.98, 1.06, 1.23, middle two averaged — **0.91×**, higher in 2 of 6, inside the pre-registered 0.80–1.25 band: **no measurable effect at 20% resolution**. A memory about an unrelated task: **0.99×**, same estimator, higher in 3 of 6 |

**What is not claimed here.** No token saving. No dollar figure. The seat above is a local box with no cache price; on a hosted provider a cache miss costs roughly 0.1× read and 1.25× write, which is a different claim and cannot be quoted from these numbers.

**Rules for any cost claim in this repository** — the published numbers live in `bench/claims.json`, and `test/claims.test.ts` enforces that file and this one in CI:

- No cost claim below **n=6 pairs per arm**. A ratio at `6 ≤ n < 21` is labelled **"20% resolution"**.
- A **seat** and a **metric** are named on the same line as the number.
- The word "cheaper" does not appear without those.
- An issue or PR body making a cost claim owes the same n, seat and metric. CI reads only this file, so that half is enforced by review.
- Nothing reproduces at n=1: the same arm on the same fixture, both runs passing, differed by more than 2× in tokens.
- Cache state is reported, never assumed. Two runs that start from different cache states are not a saving.

## Token cost and caching

Injecting memory costs prompt bytes, and prompt bytes are what a provider bills against. So the plugin treats the injected block like a cached HTTP response: it is recomputed only when the content the model is actually reading changes, and until then it is delivered byte-identically and served from cache.

- **The frozen bytes are the authority, not the store fingerprint.** A row promoted elsewhere in the store that changes nothing visible costs no cache bust. A memory *you* saved in this session is already in your own transcript, so it does not bust your cache either; a correction of a row you are riding, or anything another session, the viewer or an import wrote, still lands on your next request.
- **Two concepts, not one.** A free-text prompt must share at least two distinct concepts with a memory to be injected; one- and two-word queries need only one. `memory_recall` still reaches the single-word coincidences when you ask on purpose. Identifier spellings count once: `getUserAccount`, `get_user_account`, `get-user-account` and `get.user.account` are one concept rather than four ([#409](https://github.com/abogartz/opencode-self-improvement/issues/409)).
- **Things you said outright ride first.** A row auto-capture tagged `user-guided` — "the correct sales tax rate is 8.25%" — rides ahead of the lexical picks, newest-first, at most three, inside the budget. Only auto-capture mints the tag; `memory_remember`, updates and imports strip it, because always-riding priority is a poisoning amplifier.
- **Budgets are hard, receipts are real.** The block and each pull are capped at `injectBudget` characters, the frontier at `frontierBudget`, trimmed at whole-memory boundaries. The badge shows the provider's own `tokens.cache` accounting; a host that reports nothing shows nothing. Auto-capture is the one place with no receipt at all — it is its own call after the turn — so `memory_status` prints it as `receipt=none`, an estimate.

**Bench** — on a deterministic workload the shipped policy injects **12.3% fewer characters** than the naive policy, measured over the whole memory section: bytes on a synthetic run, not tokens and not a provider bill. The four-policy table, what the invalidation counter does and does not count, what the workload cannot show, and an author-reported provider audit (input tokens only, not a total and not a saving): [docs/injection-cost.md](docs/injection-cost.md). Reproduce the byte workload with `bun run bench`.

## Recall quality

No vector database, no embedding model, no API key: a keyword matcher. That is a trade, and here is the price, measured against classic BM25 on a deterministic eval (store of 200, k=3 — the production injection limit). **Bench**:

| Query, vs. the stored memory | share | R@1 | R@3 | with `kw` R@1 | with `kw` R@3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| lexical — reuses your project's words | 46% | 98% | 98% | 98% | 98% |
| near — reworded, one overlap | 17% | 28% | 28% | 67% | 72% |
| strict — zero shared words | 37% | 0% | 0% | 26% | 26% |

"with `kw`" is the same matcher over the same store with each row's write-time keywords indexed; the only changed variable is the index.

- **Most in-project prompts are lexical** (`bun test`, "the rate limiter", "staging deploys"): 98–100% R@3, flat from store size 50 to 500.
- **A zero-overlap paraphrase is the real limit, and write time is where you answer it.** "How we deploy" will not match a session that types "ship to staging" unless you say so: `memory_remember` asks each row for 3–5 `kw` aliases — other names, other verb forms, the literal command — indexed and never rendered. Strict R@1 0% → 26%, near R@1 28% → 67%. Narrowed, not removed.
- **`memory_recall` returns 5 rows, not 20.** A live audit of 1,090 recall events found a rank-1 row used in a later tool call at 3.4x the rate of a random store row, and ranks 11–20 at 1.16x — noise. Cutting the default from 17.7 rows left recall@1 and recall@3 unchanged, raised precision 4.1% → 13.1%, and dropped 74% of the returned characters ([#409](https://github.com/abogartz/opencode-self-improvement/issues/409)). Pass `limit` for a wider sweep.

The abstain-by-design rule, the permutation control behind the `kw` numbers, and the eval's caveats — a synthetic dataset, an adversarial class mix, single-gold scoring: [docs/recall-quality.md](docs/recall-quality.md). Full methodology and all store sizes: `bench/recall-results.md`.

```sh
bun run bench:recall
```

## Write latency

A write that cites code references builds one tree index — a single recursive walk that prunes `node_modules` and VCS directories — shared by GATE-1 and GATE-2, and reads each source file at most once. **Bench** — measured on a 5,300-file fixture (300 sources + 5,000 `node_modules` decoys), scope seeded with 5 embedded call forms:

| Call forms in the write | Shipped | One scan per form |
| --- | ---: | ---: |
| 1 | 17ms | 105ms |
| 3 | 15ms | 136ms |
| 5 | 20ms | 169ms |

The shipped column is flat: the tree is walked once no matter how many references the write cites.

```sh
bun run bench:write
```

## The store keeps score

The plugin keeps a use ledger — a due-date card for every row: who looked at it, when, and how it reached them. It is append-only, never ingested as a memory, and reported in `memory_status` and the `/memory` panel. Illustrative output — shape, not a measurement:

```
STORE
  41 active · 12 superseded · 4 open · 6 scopes
  retrieved 33 rows in the last 30d; never retrieved 8 (20%) — reported, not acted on
  24.1 KB total · 604 B per row · 1.3 rows/day (30d)
```

- **Use has three distinct sources** — the row rode the injected block, `memory_recall` returned it, or a grep/read pull appended it — because "the model asked" and "the harness offered" are different facts. No prompt content is stored: the ledger keeps a scan-truncated string from the *memory* side, never your message.
- **Reinforcement is a tie-break only** (`useBoost ≤ 1.0`): a recently used row wins a tie and can never outrank a real score gap.
- **`never retrieved` is stated, not acted on.** Pruning is your decision.
- **Aggregate STORE counts are machine-wide by decision (#213 B)** — they describe the store on this machine, not your slice of it. Privacy applies to the content surfaces instead: `memory_evidence` and the recent-blocked-writes list follow each reader's repository visibility (#306).

The credit rule and its throttle, the consolidation tie-break, and capture lag: [docs/use-ledger.md](docs/use-ledger.md).

## Consolidation

`memory_consolidate` finds near-duplicates and proposes merges. It writes nothing; each proposal prints the exact `memory_merge_review` call that resolves it, and resolving is supersede-not-delete.

The rule is: never merge two entries unless every question that used to find either one still finds the merged row.

- **Deterministic.** The canonical row is the survivor's prose verbatim plus the absorbed rows' aliases as keywords. No model rewrites anything.
- **Proven by recorded reads.** Every read the ledger recorded for a cluster is replayed against the merged store, and a merge is proposed only when the canonical row catches at least as many of the cluster's own reads as the best single member did alone. A cluster with no recorded reads is reported as *unmeasured* and never merged on resemblance.

**Bench** — on the eval dataset the pass takes 200 rows to 52 with **R@3 52 → 53 and R@1 52 → 50**, and store-wide injected characters 25 945c → 6 933c. Both the regression and the budget swap are bounded in CI (`test/consolidate-bench.test.ts`).

## Secret redaction

One best-effort credential rule set (`src/secrets.ts`) replaces recognized values with `[redacted]`. It runs at every boundary a credential could persist, not one:

- over the auto-capture prompt before it leaves the plugin — the complete transcript is redacted *before* the character budget crops it, so a credential cut in half still matches its pattern;
- at the write gate, before content is hashed or analysed;
- again in the final write choke point used by gated writes and by the viewer's edit and restore paths;
- at the durable audit boundaries — every evidence line, every supersede field written into a retired row, and every deletion-audit reason.

So a recognized credential cannot persist in a new `evidence/` line, in a deletion-audit `reason`, or in a supersede field written into a retired row, whichever path carried it. It is not scrubbed from everything those paths touch — see the limits below.

Covered: OpenAI `sk-`, GitHub `ghp_` / `gho_` / `github_pat_`, Slack `xoxb-` / `xoxp-`, AWS `AKIA`, Google `AIza`, bearer tokens containing digits, PEM private-key blocks, and high-entropy values assigned to names ending in `_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD` (plus `password`).

Limits worth knowing:

- It can miss hex-only secrets, low-diversity passwords, and credentials written in prose without an assignment.
- Credential-shaped `scope`, `tags` or `issue` metadata is rejected rather than silently rewritten.
- `memory_remember` still replies `Remembered` when content was redacted, so the stored text can differ from what was sent.
- Redaction is forward-only: existing stores are not scrubbed. `memory_export` scrubs credentials out of `content`, `issue`, `scope`, `tags` and `kw` as it serialises, so the file that leaves the machine carries `[redacted]` where a stored row still holds a token; the store itself is untouched, and origin stamps (`repo`, `repoPath`) are written as stored. The scrubber is a best-effort sweep over known token families and high-entropy credential-shaped values — an exotic credential can survive it, so an export is still a file you hand out deliberately.
- Deleting a row copies it, it does not scrub it. `deletions.logfmt` keeps the deleted row's `content`, `tags`, `kw` and `issue` exactly as the row held them — a restore-entry built from that line has to re-stamp and re-attach precisely what was there — and redacts only the `reason`. So deleting a row that predates redaction writes its credential into the audit. Snapshots carry whatever a stored row holds, for the same reason. That retention is deliberate (#292).

## Export and move between machines

`memory_export` writes the store as JSONL, **as its caller can read it**: from a plugin session that means your repository plus global rows. Full-store breadth belongs to a session-less caller outside the plugin — the library route; the viewer has no export route. `memory_import` reads such a file back, and every imported row re-enters through the same four gates as `memory_remember` (tagged `import`, original tags preserved).

To move a store between machines:

```
Export my memories                              # -> <memory-root>/exports/<timestamp>-<unique>.jsonl
# …copy that file to the other machine's <memory-root>/…
Import <memory-root>/memories.jsonl             # memory_import
```

Both tools are model-facing, so a path is not a privilege: `file` must stay inside the store — exports under `<memory-root>/exports`, imports anywhere under `<memory-root>` — and a symbolic link cannot carry a request out of it. Pass `scope` to export one scope. An operator running a one-off migration can restore the old anywhere-on-disk behaviour with `OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS=1`, which is read from the plugin process's own environment so a model cannot grant it to itself. The file format and the confinement rules with their known limits: [docs/import-quarantine.md](docs/import-quarantine.md).

The import reply is a tally, not a yes/no:

| Outcome | Meaning |
| --- | --- |
| `promoted` | passed the gates and was stored |
| `collapsed` | near-duplicate of an existing memory; nothing written |
| `blocked` | rejected by a gate; reason in `memory_evidence` |
| `skipped` | malformed line; never reached the gates |
| `downgraded` | imported as settled because its `status:"open"` could not be vouched for |

Import and auto-capture also scan incoming prose for instruction-override, role-header and download/execute patterns. A promoted match is tagged `quarantine` and withheld from recall, prompt and frontier injection, compaction anchors, contextual pull, consolidation and decay. Think of it as a spam folder, not a virus scanner: legitimate documentation can match, and several forms evade it. Review the queue in the viewer's **quarantined** filter.

What the screen covers, what it misses, how an existing store is re-tagged, what releasing quarantine does and what it leaves alone, and why direct `memory_remember` and viewer edits are not scanned: [docs/import-quarantine.md](docs/import-quarantine.md).

## Surfaces

Same data behind each one (`memory_status`; no model call).

**Terminal (opencode CLI)** — the plugin ships a TUI half (`@opencode/plugin/tui`) that loads automatically:

- **Footer badge** — illustrative `● mem 1157/1200c · cache 96%`: the injected block against its budget, plus the measured session prompt-cache hit rate. The dot is green (stable and warm), yellow (recent recompute, or 50–90% reads) or red (last turn served almost nothing from cache); `—` until the first assistant turn, and `—` throughout on a provider that reports no cache usage.
- **`/memory`** — session panel: **CONTEXT** (what is riding the prompt now and how much of the budget it uses), **CACHE** (busts this session and the measured cache-served share of prompt tokens), **INJECTED BLOCK** (the verbatim block, or an explicit abstention), **RECENT BLOCKED WRITES** (with gate reasons), **STORE** (active / superseded / open / scopes, plus `malformed` when a row's `ts` is not a valid ISO instant — those rows are skipped by every reader). Keys: `r` refresh, `f` fullscreen.
- **Block toast** when a write is refused (`"notifyBlocked": false` to silence).

**Desktop / web / IDE** — the terminal slots do not exist there, so use the self-installed **`/memory-report`** chat command: the same sections rendered in the conversation.

**Browser editor** — `bun memory-view`, then http://127.0.0.1:8787. Bound to loopback; requests are checked against `Host` and `Origin`, so other hosts must be listed explicitly in `OPENCODE_VIEWER_ALLOWED_HOSTS`. Listing a non-loopback host serves the store over plain HTTP with no authentication — only do it on a network you control. `OPENCODE_VIEWER_HOST` changes the bind interface.

## Development

Nothing merges without the full gate; CI runs it as required checks (`lint`, `test`, `smoke`), and the same sequence is one command locally:

```sh
bun run gate          # typecheck + lint + unit tests + terminal smoke & BDD
bun run gate:hooks    # once per clone: run the gate on `git push`
bun run format        # apply the shared two-space TypeScript/TSX style
```

Use Bun **1.4.4** for development checks, matching CI. `bun run test` and `bun run test:e2e` run files across at most four worker processes; cases inside each file stay sequential because fixtures share environment variables and module state.

**Feature order is BDD-first.** A new feature starts by adding or fixing a scenario in `e2e/` that describes the behavior as a user would observe it — before implementation code and before unit tests. If no scenario turns red first, the feature has no observable contract.

`e2e/` boots the **real opencode CLI** in a fully isolated instance against a scripted fake model — no API keys, no shared store. It needs `opencode` on `PATH` locally, or `OPENCODE_BIN`.

**The published surface is `package.json`.** A new top-level file, or anything the plugin reads at runtime outside the packaged paths, must be added to `files` or it works from the checkout and vanishes from the npm artifact.

How the local commands map to CI job names, what the smoke suite really boots, and the pre-release mutation sweep with its artifact policy: [docs/development.md](docs/development.md) and [docs/pre-release-ritual.md](docs/pre-release-ritual.md).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `memory_*` tools not available | The plugin didn't load. Restart opencode and check the `plugins` entry in your config. |
| `memory_remember` says blocked | A gate rejected the write: a stale code reference, a cited path that doesn't exist in the repo, overlap with a superseded memory, or an ambiguous claim. The reason is in `memory_evidence`; rephrase against current code and retry. |
| `invalid arguments to memory_*` | The call didn't match the tool's input schema; nothing was done and the message names the offending fields. Gate blocks look different (`blocked at GATE (…)`). |
| `memory store is busy` | A store write exhausted its 5s lock-wait budget, so the mutation is refused rather than run unlocked. Retry after contention clears. An operation spanning several files or steps may have completed earlier steps; refusal is not a rollback of those steps. If the reply reports `PARTIAL`, inspect the named rows and `memory_evidence` / `memory_undo` before retrying. A process that is killed releases the lock when it dies — there is no stale window to wait out. |
| Writes report a disk I/O error and the store is on a share | The lock's write-ahead log needs mmap'd shared memory, which SQLite does not support on network filesystems. SMB, NFS and OneDrive-mounted roots are unsupported — move `OPENCODE_MEMORY_DIR` to local disk. |
| Stale plugin after an update | `opencode plugin update opencode-self-improvement` (or bump the pinned `@version` in the `plugins` entry) and restart opencode. On desktop use `opencode service restart`: relaunching the app leaves the background service — and the plugin version and options it already parsed — alive. |
| Auto-capture does nothing | `memory_evidence` says which case you are in from the `plugin_load` line: `capture=off` (the option is not on), `invalid_model` (`captureModel` must be `provider/id`), `no_capabilities` (the host did not expose what capture needs), or `capture=on`. `capture=on` with no `auto_capture_*` line after a session means the pass did not complete, and is not your configuration — see [Auto-capture](#auto-capture). On desktop, changing any of these options needs `opencode service restart`. |

`STORE` showing malformed rows, stray lock files in the store, a missing `/repo-init`, a `memory_init` call naming `mode`, `Error: Plugin is not configured` right after `plugin add`, and a clean reset on Windows: [docs/troubleshooting.md](docs/troubleshooting.md).
