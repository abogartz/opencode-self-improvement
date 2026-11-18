# Import, quarantine and the viewer's edit path

A quarantined row is a spam-folder row, not a deleted one: it stays in the
store where you can read it, and is withheld from everything the model reads.

What the prose screen catches and misses, how an existing store gets
re-tagged, what releasing quarantine does, and which writes it does not
cover. The README keeps the export/import contract and the tally.

Import and auto-capture also scan incoming prose for a small set of instruction-override, role-header, and download/execute patterns. Matching rows still face every write gate; a promoted match is tagged `quarantine` and withheld from recall, prompt/frontier injection, compaction anchors, contextual pull, scope/type listings, consolidation proposals, and decay. Decay previews do not quote these rows, and applied decay leaves them in the human review queue. The import reply counts quarantined promotions, gate evidence records pattern identifiers without copying the matched prose, and `/memory-report` lists review IDs for the caller's repository.

That screen only covers writes made after it shipped. A store that already holds an untagged poisoned row from an earlier `/repo-init` is repaired by the next one (#375): init scans every row the caller can read (this repository plus global) and, for each hit, writes a tagged twin through the normal gated path and retires the original — nothing is deleted, and each replacement emits its own `write_promoted` audit line. Re-running is safe: a row that already carries the tag is not touched. The reply reports `re-tagged=N`; a hit the gate refused is reported as `blocked=N` instead of passing silently, one run re-tags at most 100 rows and says how many remain, and any row GATE-2 retired along the way is named. A promoted replacement whose audit line itself fell is counted as `N without an audit line` rather than passing as a clean repair. This runs even when init skips on its stamp, because a stamped repository is the common case.

Review the full row in the memory viewer's **quarantined** filter. **Release quarantine** requires a reason, snapshots the pre-release row, and removes the quarantine flag and known scanner-reason tags; unrelated user labels such as `quarantine:custom`, repository ownership, row identity, blocklist, and supersession remain intact. Missing and already-released rows produce distinct, audited no-op outcomes. Existing prompt blocks refresh before the next delivery or status report when a row becomes quarantined or is released. Undoing a release can restore the quarantine flag.

This is a heuristic review queue, not a complete prompt-injection detector: legitimate documentation or quoted code can match. Markdown-bold role headers and download-then-`&&`-execute forms are recognized, but alternate role delimiters such as `[INST]` / `<<SYS>>`, base64-to-shell pipelines, paraphrased instructions, and indirect execution can evade it. Direct `memory_remember` and human viewer edits are explicit writes and are not automatically scanned: a session with that tool still has a prose channel, mitigated by the existing framing and provenance rather than quarantine. Those defenses still apply to released rows.

Always-ride guidance priority is reserved to auto-capture provenance. `memory_remember`, `memory_update` replacements, and JSONL imports silently remove `user-guided` (including comma-delimited tag entries) before the write gate; their field allowlists also exclude `ref`, `claim`, and `klass`. Ordinary tags and prose can still promote normally, but a portable file, even with an export header, cannot attest that the local user stated it. The capture path owns guidance metadata; this boundary protection does not authenticate a directly edited store or guarantee that a capture model classified a statement correctly. The reservation applies to guidance priority and contradiction verdicts (#342, #349).

The viewer is a trusted admin editor: its edits and deleted-entry restores do not run the model-facing grounding or deduplication gates, but they honor the same exact and near-match value rejections. Rejected edits leave the original row, snapshots and edit audit unchanged; rejected restores append nothing. The refusal names the rejection hash so you can explicitly lift it under **Rejections → un-reject** before retrying. Corrected numeric values and polarity changes retain the rejection check's existing exceptions. This check does not change whole-snapshot rollback policy.

Existing stores are not rescanned. A byte-identical import that collapses into an existing row does not retroactively tag that row. Export preserves quarantined rows and their tags to avoid data loss; an exported released row can be quarantined again when re-import promotes it on another machine.

## The file format, and what an import will believe

A header line (`{_export, version, exportedAt, count}`) followed by one JSON object per line (`{ts,type,scope,content,status,tags,issue}`), active rows only.

An open row is exempt from reference grounding, so that status is honored only for files carrying an export header — a hand-written file without one imports such rows as settled. Even with a header: an open row claiming `repo:"global"` is downgraded, and imported `repo` / `repoPath` stamps are kept only when they match the importing session's current repo — foreign stamps are dropped and the row is stamped for the importing repo. Re-running the same import in the same repo is a no-op.

## Keeping a path inside the store

Both tools are model-facing, so a path is treated as untrusted input rather than as permission. An export cannot write to `~/.gitconfig` or anywhere else outside the store, and an import cannot read outside it. Symbolic links are resolved before the check — including an `exports/` directory that is itself a link — so a link cannot carry a request out of the store. Exports are written `0600` and opened `O_NOFOLLOW` (both POSIX; on Windows the check before the write is the only guard).

The default name is `<memory-root>/exports/<timestamp>-<unique>.jsonl`, created exclusively, so two exports in the same second never replace each other's artifact.

Two limits no path check can close. A hard link planted inside `exports/` shares an inode with its target, so writing through it writes the target. And the check covers the final component more tightly than the intermediate path components, leaving a narrow window there. Both are stated rather than fixed because closing them means giving up the feature.
