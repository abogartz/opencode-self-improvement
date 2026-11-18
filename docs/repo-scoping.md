# Repo scoping: identity, visibility and write refusal

Every row carries a label saying which repository wrote it. The label is
checked on the way in as well as the way out, and the two directions are not
symmetric: reading one extra project's memories is a nuisance, while writing
your private note into the wrong project is damage. So reads are permissive and
writes are strict.

The README states the rule; this is the boundary detail.

## Identity

Legacy whole-path-lowercased hashes accompanied by `repoPath` are matched to that directory (including real aliases), so a distinct case-sensitive sibling cannot inherit its memories or evidence. Remote-derived identities still share across clones. Stamps without `repoPath` retain key-only matching; their historical identity source cannot be recovered from the key alone.

## Who sees what

Injection, recall, the frontier block, compaction, `memory_forget` and decay only see the current repo plus global rows, resolved from the calling session's identity at flow entry. A session that reaches a plugin instance is bound to that instance's own workspace on first contact — in a process hosting several workspaces, one session never borrows the repository some other workspace's setup left behind. A session whose repository cannot be resolved at all sees global rows only; "unknown" is never "everything".

## Why an unresolved session cannot write

Writes follow that rule in the stricter direction. A named session with no resolved repository has **no write target**, so `memory_remember`, `memory_update`, `memory_import` and auto-capture refuse it (evidence `write_refused`) and store nothing. The alternatives were stamping your private content into whichever workspace's `setup()` ran last, or publishing it to every project as an unstamped row.

A caller that names no session at all (the viewer process, a restore, a script) keeps the process scope, and an explicit `global: true` is a deliberate owner. Preferences that should follow you everywhere go in with `memory_remember global: true`. Rows written before scoping existed are global. Upgrading changes nothing.

`memory_merge_review` applies the same rule to its inputs: a session may merge exactly the rows it may read — global rows plus its own repo's, from either seat — and a row id it merely knows is not authority to retire another repo's memory.

## Evidence attribution

Evidence lines carry the same stamp, so `memory_evidence` answers from the caller's repo plus global lines; a line a named session wrote while its repository was unresolvable is private to that session, and only an explicitly global (or predating-stamps) line reads as global.

Gate-authored evidence and its init/capture lifecycle records capture attribution at operation entry: if a session moves repositories while the operation runs, its audit lines remain in the starting repository's partition and can be read with `memory_evidence` from a session bound there. Init start/complete/skip, capture outcomes/refusals, and capture lag share that captured owner. A captured named session with no resolved repository keeps a session-private `sid` label even on lifecycle records that suppress call metadata; otherwise an unstamped line would appear global.

## The viewer

The viewer is an admin surface over every repo: it edits and restores a row with its own repo stamp, and the viewer's missing session scope never decides a row's visibility. Viewer audit attribution and cancellation of in-flight capture are separate boundaries.
