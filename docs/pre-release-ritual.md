# Pre-release ritual: mutation sweep and artifact policy

A fire drill for the test suite: break one claimed invariant on purpose and
see whether anything notices. A mutant that no test kills is not a scandal —
it is a list of what the suite has been claiming without pinning.

What `scripts/test-sweep.ts` measures, when a person runs it, and which
benchmark artifacts stay out of git.

```sh
bun run sweep:test
```

`bun run sweep:test` (`scripts/test-sweep.ts`) audits the test suite rather than testing the plugin. Each mutant breaks exactly one claimed invariant in a detached `git worktree` of HEAD, runs the `test/` suite (unit + scenario) against that mutated tree, and reports whether the suite noticed. A mutant no test kills is an unpinned invariant: the test titles may claim coverage, but nothing died with the invariant. The clean tree is measured first and its failing tests are subtracted from every mutant run, so only new failures count as a kill and a flake never masquerades as one. Mutants are applied only to scratch worktrees beside the checkout, never to the working tree under your feet.

The output is a canonical mutation score — killed over total, with equivalent mutants and load errors excluded from the denominator — plus the survivors, the unpinned invariants. Survivors are the audit's output, not a scandal: some mutants are expected to survive and become entries on the unpinned list rather than red CI.

Run it when you want to know whether the suite still has teeth — after changing tests or coverage, or as a pre-release gate with `bun scripts/test-sweep.ts --fail-on-survivors`, which exits 4 when anything survives. Two lighter checks come first: `bun scripts/test-sweep.ts --validate` confirms every mutation pattern still lands on exactly one source site without running the suite, and `bun scripts/test-sweep.ts --selftest` plants a mutation in a trivially-tested pure function and fails unless the suite kills it — proof the instrument itself can go red.

**Pre-release ritual (decided 2026-11-04, #72):** before pushing a release commit, a human runs `--validate`, then `--selftest`, then `--fail-on-survivors`, and records the mutation score and the survivor list in `bench/RESULTS.md` beside the published evidence. Cadence is pre-release only, run by a person: the sweep is a full suite per mutant and never belongs in CI, where it would cost more than it informs. Survivors become entries on the unpinned-invariant list, not red checks.

### Bench artifacts stay out of git

Raw sweep output is regenerable measurement data, and it was the largest tracked content in the repository. It is not committed (#232). A clone carries the published summaries — `bench/RESULTS.md`, `bench/recall-results.md`, `bench/test-sweep-results.md`, `bench/capture-trigger-results.md` — and the inputs those summaries are rebuilt from. History is not rewritten: the old blobs stay in earlier revisions, so this shrinks new checkouts, not the archive.

| Artifact | How to get it back |
| --- | --- |
| `bench/append-publication-198/` and its runner | The git history: `git log -- bench/runners/append-cost-198.ts`. The runner measured two pinned checkouts of pre-#168 modules and no longer runs against a current tree. |
| A mutation sweep log | `bun scripts/test-sweep.ts --log=<path>`. |

A script that needs a missing artifact names the file and the command that produces it instead of throwing a stack trace.

The `#71` set (`bench/test-integrity-71.json`, `bench/test-integrity-71/{before,after}.jsonl`, `bench/test-integrity-71-verdicts.json`, `bench/test-integrity-71-probes.json`) and its one-shot triage script are retired: the published numbers live in `bench/test-sweep-results.md`, and the raw files stay recoverable from history (`git log -- bench/test-integrity-71.json`).
