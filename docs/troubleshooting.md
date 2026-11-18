# Troubleshooting, full list

The README keeps the problems people actually run into. This file holds the
rarer ones, and repeats the common ones so one search finds the whole list.

## Rarer problems

| Problem | Fix |
| --- | --- |
| STORE shows `N malformed` | A daily file has a `ts=` that is not a valid ISO instant (typically a hand-edit). Every reader skips those rows; fix the `ts=` or restore the file with `memory_undo`. |
| Stray `*.logfmt.lock` or `*.tmp` in the store | Write bookkeeping left by an older release; safe to delete while nothing is writing. Current releases leave `.store-lock.<file>.sqlite` beside each store file and `.store-batch.<name>.sqlite`: coordination state, holding no rows, one file per lock, safe to delete while nothing is writing. |
| `/repo-init` missing from the command list | The self-install couldn't write to `~/.config/opencode/commands/`. Create it and restart, or ask the model to "init memory for this repo" — the same tool. |
| `memory_init` rejects a call naming `mode` | The code-graph integration was removed (#231) and the tool schema refuses unknown arguments — drop `mode` from the call. Stamps written by older versions (their text carries `graph=`/`mode=`) still read fine; no re-init is forced. |
| `Error: Plugin is not configured` right after `plugin add` | An opencode bug ([#54654](https://github.com/anomalyco/opencode/issues/54654)), not a config problem: the first `plugin list/check/update` against a cold background service reads the plugin inventory before activation finishes. The plugin is installed and loading — just run the command again. |
| Reset all memories | Stop any running opencode session first, then delete `~/.config/opencode/memory/`. On Windows the delete fails with `EBUSY` while a session is live: the store lock is an open SQLite connection, and Windows will not delete a directory that contains one. |

## Common problems

Kept in [README → Troubleshooting](../README.md#troubleshooting): tools not
available, a blocked `memory_remember`, an argument-schema rejection,
`memory store is busy`, a store on a network share, a stale plugin after an
update, and auto-capture doing nothing.
