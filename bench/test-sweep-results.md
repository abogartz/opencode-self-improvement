# The mutation sweep: what the suite actually pins (issue #70)

Historical measurement: for the later #71 catalog and pinned before/after results, see [test-integrity-71.json](test-integrity-71.json). The denominators describe different trees/catalogs and must not be combined.

The #71 inputs are retained as [before.jsonl](test-integrity-71/before.jsonl) and [after.jsonl](test-integrity-71/after.jsonl). From the repository root at the #195 branch, rebuild with `bun scripts/triage-71.ts bench/test-integrity-71/before.jsonl bench/test-integrity-71/after.jsonl <output.json>`. These logs reproduce the original pinned report, not a new sweep of subsequent changes. Per-test kill sets are observations from those runs, not stable coverage quantities.

One question, answered mechanically: when an invariant dies, does anything die with it? Each mutant breaks
exactly ONE claimed invariant in a detached scratch worktree of HEAD and runs the full suite against that tree.
A mutant nothing kills is an invariant the suite does not actually depend on, whatever the test titles claim.

**Run:** src as of main @ `7bfe99b` (no `src/` file is touched by this branch - its only shipped-file
change is `package.json` +1, the `sweep:test` script), instrument `75fd932` (anchors re-pinned for #89)
plus the #110 review fixes through `20e77ae` - those later fixes cannot move a Windows number (the
scratch's node_modules was a real directory here the whole time; post-fix Windows re-runs reproduce
verdicts bit-identically), which is why the table below stands on the earlier instrument:
mutant anchors re-anchored where #89 moved the publish path (see the lineage note), Windows, Bun 1.3.10,
43 mutants, one run each with 3-run confirmation for timing-only evidence. Baseline (clean tree) first:
**483 pass / 0 fail / 5 skip** - zero known-reds: the four Windows torn-read/EPERM races that motivated
baseline subtraction are pinned as of #89/#105. Subtraction stays anyway (a green baseline still lies the
other two ways - see Method notes), it just no longer has anything to subtract. A kill resting only on
timing-sensitive tests is confirmed to 3 runs; unstable = timing luck, reported, not credited. Both
kill→survive verdict flips against the previous table were re-run 3x on a quiet machine before being
published (see the delta section).

**Platform note:** the score is the **Windows** number. POSIX legs became possible only with the #110
review fixes (`git clean` no longer deletes the scratch's symlinked node_modules; the tally parser reads
anchored summary lines, not first matches that echoed test titles can poison), and they legitimately
diverge - `publish-rename-to-truncate` for instance is killed 1/1 here but survives on Linux/macOS, where
a truncating direct publish never opens the window the kill stands in. Same suite, different syscalls.
`publish-rename-since-blind` is the vacuous class: `handoverRename` throws immediately for
`!IS_WINDOWS`, so the anchored retry loop - and with it the identity recheck the mutant blinds -
is never entered; a POSIX sweeper must not be filed against it as a catalog gap.

## Score

**36/42 = 85.7%** canonical (43 mutants, 1 excluded equivalent, 0 load-errors). Full status table:
| status | runs | mutant | class | invariant | killed by |
| --- | --- | --- | --- | --- | --- |
| killed | 1/1 | `lock-noexcl-mutex` | D2 | lock file is created with O_EXCL: the mutex is cross-process | concurrency.test.ts, lock.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `lock-no-stale-steal` | guard | a lock abandoned by a dead process is taken over after age | concurrency.test.ts, lock.test.ts, scenarios-consistency.test.ts |
| survived | 0/1 | `lock-restore-failopen` | D2 | restore fails CLOSED on a busy store, because force drops rows | — |
| killed | 1/1 | `publish-rename-to-truncate` | D2 | whole-file publishes hand over by rename: readers (no lock) | logfmt.test.ts |
| killed | 1/1 | `append-truncate-regression` | D2 | appends are one O_APPEND write, never a replacing write | boundaries.test.ts, capture-compaction.test.ts, capture.test.ts, compaction.test.ts, concu… |
| killed | 1/1 | `append-nolock` | D2 | appends hold the store lock: none lands inside an RMW window | concurrency.test.ts, scenarios-consistency.test.ts, supersede-batch.test.ts |
| survived | 1/3 | `supersede-rmw-nolock` | D2 | supersede is a locked read-modify-write (stampRow) | — |
| killed | 3/3 | `prune-nolock` | D2 | prune filters and republishes under the store lock | concurrency.test.ts, scenarios-consistency.test.ts |
| killed | 1/1 | `prune-repofloor-off` | guard | forget never deletes another repo's row for the same scope | repo-scope.test.ts |
| killed | 1/1 | `blocklist-poison-filter-off` | guard | blocked (poisoned) rows are filtered from every read path | concurrency.test.ts, epoch.test.ts, negative-eval.test.ts, undo.test.ts, viewer.test.ts |
| killed | 1/1 | `malformed-ts-guard-and` | guard | a non-ISO ts is malformed: skipped, never an addressable row | boundaries.test.ts |
| killed | 1/1 | `redact-chokepoint-off` | guard | secrets are redacted at the single write choke point | concurrency.test.ts, viewer.test.ts, write-caps.test.ts |
| killed | 1/1 | `metadata-secret-guard-off` | guard | credential-shaped metadata is refused, not stored | keywords.test.ts, write-caps.test.ts |
| survived | 0/1 | `snapshot-overwrite` | D4 | claimSnapshot bumps names with O_EXCL: a snapshot is never | — |
| killed | 1/1 | `visible-global-off` | guard | repo visibility: explicitly-global rows stay visible everyw... | repo-scope.test.ts |
| killed | 1/1 | `undo-force-safety-removed` | D4 | force-restore snapshots what it drops, inside the lock: | concurrency.test.ts, scenarios-consistency.test.ts, scenarios-scripted.test.ts, undo.test.ts |
| killed | 1/1 | `undo-force-safety-after-publish` | D4 | the safety copy is taken BEFORE the publish that drops rows | concurrency.test.ts, scenarios-consistency.test.ts, scenarios-scripted.test.ts, undo.test.ts |
| killed | 1/1 | `undo-check-mutates` | D1 | check mode never writes: a diverged store is refused, untou... | scenarios-consistency.test.ts, undo.test.ts |
| killed | 1/1 | `undo-escapes-root-branch` | D3 | containment: the requested snapshot path stays in snapshots/ | undo.test.ts |
| killed | 1/1 | `budget-overlong-breaks-scan` | pure | capToBudget skips over-long lines and keeps scanning the rest | epoch.test.ts |
| killed | 1/1 | `budget-dangling-header` | pure | a block trimmed down to headers is dropped, never injected | epoch.test.ts |
| equivalent | - | `budget-header-fit-boundary` | pure | a header exactly the size of the budget still counts as fit... | — |
| killed | 1/1 | `repokey-colon-form` | pure | every transport form of one remote hashes to one repo key | repo-scope.test.ts |
| survived | 0/1 | `viewer-snapshot-grammar-off` | D3 | restore names are pinned to the snapshot grammar at the wire | — |
| killed | 1/1 | `viewer-host-guard-off` | guard | the loopback viewer rejects foreign Host headers (DNS rebin... | viewer.test.ts |
| killed | 1/1 | `viewer-content-type-off` | guard | writes must be application/json (cross-site form refusal) | concurrency.test.ts, viewer.test.ts |
| killed | 1/1 | `lock-noop` | D2 | whole-file rewrites are serialized per store file | concurrency.test.ts, lock.test.ts, scenarios-consistency.test.ts, supersede-batch.test.ts |
| killed | 1/1 | `lock-release-blind` | D2 | a holder never deletes a lock another process took over | lock.test.ts |
| survived | 0/1 | `lock-default-fail` | D1 | an ordinary write proceeds rather than losing the write | — |
| killed | 1/1 | `lock-default-fail-queued` | D1 | a queued ordinary write proceeds rather than losing the write | lock.test.ts |
| killed | 1/1 | `restore-merge-drops` | D4 | merge restores the snapshot AND keeps concurrently written ... | concurrency.test.ts, scenarios-consistency.test.ts, undo.test.ts |
| survived | 0/1 | `restore-escapes-root` | D3 | a restore cannot write outside the memory root | — |
| killed | 1/1 | `row-ts-any` | guard | a row whose ts is not an ISO instant is not addressable | boundaries.test.ts |
| killed | 1/1 | `repo-floor-off` | guard | another repo's rows never surface or get deleted here | negative-eval.test.ts, repo-scope-session.test.ts, repo-scope.test.ts |
| killed | 1/1 | `content-cap-off` | guard | nothing oversized is persisted (append floor) | write-caps.test.ts |
| killed | 1/1 | `gate-blocks-ignored` | D1 | a write rejected by a gate never reaches the store | frontier.test.ts, gated-injection.test.ts, negative-eval.test.ts, path-refs.test.ts, scena… |
| killed | 1/1 | `gate-dupes-promoted` | D1 | a near-duplicate is collapsed, not stored twice | capture-compaction.test.ts, capture.test.ts, gated-injection.test.ts, init.test.ts, keywor… |
| killed | 1/1 | `gate-content-cap-off` | guard | oversized content is blocked with a reason, not stored | write-caps.test.ts |
| killed | 1/1 | `inject-one-token-shared` | pure | free-text prompts need two shared concepts to inject | consolidate-bench.test.ts, inject.test.ts, keywords.test.ts, negative-eval.test.ts |
| killed | 1/1 | `inject-frontier-uncapped` | pure | only the newest open threads are surfaced | concurrency.test.ts, frontier.test.ts |
| killed | 1/1 | `viewer-origin-guard-off` | guard | cross-origin writes to the viewer are refused | viewer.test.ts |
| killed | 1/1 | `import-frontier-any-version` | guard | a newer export header does not grant the frontier exemption | portable.test.ts |
| killed | 1/1 | `import-open-status-unconditional` | guard | status:open is honored only under its guards (export header... | injection-framing.test.ts, portable.test.ts |

Run annotations: `prune-nolock` was killed only by timing-sensitive tests and confirmed 3/3;
`supersede-rmw-nolock` was an unstable kill (1/3) - timing luck, not credited, and it lands on the unpinned
list below under #68's D2 rule.

## Unpinned invariants (the audit's output)

Six invariants the suite does not currently defend. None is a live bug found; each is a promise the tests
would not notice being broken - the cheap pins are named per mutant:

1. **`lock-restore-failopen` [D2]** (flipped from killed 3/3 on 0.13.0) - `LOCK_RESTORE.onTimeout` moved from
   "fail" to "proceed" means a force-restore runs UNLOCKED on a busy store and nothing notices. The killer
   files (`concurrency`, `scenarios-consistency`) did not change between the two swept trees; the only file
   change on the path is #89's lock rework (`21c21d7`, keep writers alive through mislabelled/vanished lock
   races) - so no scripted scenario outcome now depends on the flag. Deterministic pin: hold the store lock
   with a live writer, force a restore, assert refusal and a byte-identical store.
2. **`supersede-rmw-nolock` [D2]** - unlocked supersede (RMW without the store lock) reddened one run in
   three; the other two were clean. Killed 1/1 deterministically on 0.13.0 - #102's batch pass moved the
   timing window the old kill stood in. Pin: script a supersede racing an append to the same file through
   the seams `supersede-batch.test.ts` already has, assert no lost update.
3. **`snapshot-overwrite` [D4]** - carried over: `open(snap, "w")` instead of `"wx"`, killed 2/3 by timing
   on 0.13.0, 0/1 here. Deterministic pin: two colliding `claimSnapshot` calls, assert both files exist
   with distinct content.
4. **`viewer-snapshot-grammar-off` [D3]** (flipped from a 3/3-confirmed kill on 0.13.0) - disabling the
   restore-name wire check in `src/viewer/server.ts` reddens nothing newly here. Neither the server file nor
   the two killer test files changed between the two swept trees, which makes the verdict disagreement a
   statement about method, not code: the earlier confirmation rested on adjacent-suite timing, and the
   deterministic wire pin still does not exist. Shape: POST a restore with a bad name (planted decoy inside
   `snapshots/`) and assert the 400 and that no file was read.
5. **`lock-default-fail` [D1]** - carried over unchanged (its 0.13.0 3/3 "confirmation" was load-manufactured;
   quiet says 0 both times). The UNqueued write's lock-loss policy is untested; the queue-path sibling -
   split from the same anchor - is killed 1/1, so the same two-line pin aimed at the unqueued path closes it.
6. **`restore-escapes-root` [D3]** - carried over: the `realpath`-based root-containment throw in
   `restoreTarget` is never reached (a snapshot whose `original` resolves outside the memory root is needed);
   its `undo-escapes-root-branch` sibling IS killed 1/1.

## What changed since the `7c4a22d` (0.13.0) run

The score moved 38/42 → 36/42, and the reason matters more than the number:

- **Gained: `publish-rename-to-truncate` survived → killed 1/1** by `logfmt.test.ts`. That row was 0.13.0's
  headline finding - "the deterministic stall-a-publisher pin does not exist yet" - and it does now: #89
  shipped the publish rework with its four property pins (`a72a82b`). The loop closed exactly as #70
  intended: the audit named the missing pin, the fix landed with it, the sweep credits it. (The mutant's
  anchor moved with that fix too - re-anchored here, see lineage.)
- **Lost, on the same code moves: `lock-restore-failopen` killed → survived, `viewer-snapshot-grammar-off`
  killed → survived, `supersede-rmw-nolock` killed → unstable.** Both full flips were re-run 3x on a quiet
  machine and held at 0/3 each - deterministic survivors, not load artifacts. (That re-check's own baseline
  caught the known `supersede racing appends` race once and subtracted it, as designed.) None of the three
  is a product regression; all three are test-strength regressions caused by shipped code moving the ground
  under a kill - which is precisely what a maintained baseline is for.
- Baseline known-reds went 4 → 0 and the suite grew ~22 tests (466 → 488) since that run.

## Method notes (the honesty rules this run exercised)

- **Baseline subtraction is what makes the sweep runnable anywhere.** The shipped sweep refuses to start
  unless the clean suite is fully green; on 0.13.0-era Windows that meant the auditor could not audit
  exactly where the storage invariants are weakest. Measured knowns subtract; a known-red that dies under a
  mutant is still reported (it's news), it just isn't a kill. Current main has zero known-reds on this
  platform - subtraction now subtracts nothing and stands ready anyway.
- **Load contaminates in one direction - and confirmation runs are only valid on a quiet machine.** Extra
  load manufactures reds (false KILLS); it cannot un-red a real kill. Survivors under load are sound;
  timing-only kills under load are not. This run's two kill→survive flips went back through the quiet ×3
  gate before publication, per the lesson the 0.13.0 run recorded the hard way.
- **Calibration:** `--selftest` plants a mutant in a deliberately under-pinned pure helper and demands a
  kill - a harness that cannot go red is itself a defect. Green at `7bfe99b` on Windows; the macOS shape
  that needed the classify fix (mass-red + truncated runner = kill, not instrument failure) is fixed here.
- **Catalog lineage (corrected 2026-10-26; an earlier claim here said 24+26−5=42 - the measured accounting
  is different, per #110's review):** of the 24 mutants in the tool shipped in `6d1858b`, 19 ids survive into
  the merged catalog; 5 (`lock-never-steal`, `publish-truncate`, `blocklist-visible`, `restore-check-blind`,
  `restore-safety-stale`) were exact-duplicate breaks deduped to their rebuilt sites. With 24 entries built
  for #70 that is **43 patterns + 1 calibration plant**, all anchored exactly once (`--validate` 44/44).
  Two anchors went stale when #89 rewrote the publish path and were re-anchored at the merge
  (`publish-rename-to-truncate` onto `handoverRename`, `undo-force-safety-after-publish` onto the
  `since`-threaded call).
- **Post-table changes (the #110 companion):** the catalog gained a 44th pattern,
  `publish-rename-since-blind` (the anchored retry must re-check the destination before every rename),
  making `--validate` 45/45 with the plant. Its deterministic kill is the third handover test in
  `logfmt.test.ts`: red at ~450 ms under the mutation, 4x inside the retry window's internal 2 s
  deadline - the two pre-existing pins that also kill it land at ~1500 ms, a 1.33x margin that a
  stalled runner can flip into a silent survive. And `lock-default-fail` was re-anchored: the #107
  branch's `now()` seam moved the wait loop's bytes and rotted its anchor - `--validate` caught the
  drift the same day it landed, but nothing runs `--validate` in CI, so catalog health is still a
  manual ritual.
