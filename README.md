# @abogartz/opencode-self-improvement

Durable memory for opencode, plus a one-command per-repo setup.

## What you get

- **`memory_*` tools** — remember facts, decisions, and commands the agent should
  keep across sessions (`memory_init`, `memory_remember`, `memory_recall`,
  `memory_update`, `memory_forget`, `memory_list`, `memory_undo`,
  `memory_evidence`).
- **`/repo-init`** — for each repo: indexes the code graph and remembers the
  test/build commands, keyed to the git head. The command installs itself; no
  setup beyond the plugin.

## Quick start

1. Install the plugin and restart opencode (see install below).
2. In any repo, run:

   ```
   /repo-init
   ```

That's it. Rerun `/repo-init force` after a refactor to refresh.

## How to install

The plugin is published to npm as `@abogartz/opencode-self-improvement`.

```sh
opencode plugin @abogartz/opencode-self-improvement@latest --global --force
```

This installs the package and registers it in your opencode config. Restart
opencode — the plugin loads and `/repo-init` installs itself automatically.
Nothing else to do.

## First use

Run `/repo-init` once in every repo you work in. It:

- indexes the repo's code graph (`codebase-memory-mcp`), only when missing or forced;
- stores the test/lint/typecheck commands as memories;
- writes an init stamp tied to the current git head.

Ongoing use is just the memory tools. Ask the agent to remember something and it
sticks across sessions; check what's stored with `memory_list`, refine with
`memory_update`, retract with `memory_forget`, roll back with `memory_undo`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `memory_*` tools not available | The plugin didn't load. Restart opencode and check the `plugin` entry is spelled `@abogartz/opencode-self-improvement`. |
| `/repo-init` missing from the command list | The self-install couldn't write to `~/.config/opencode/commands/` (e.g. read-only config dir). Create it, restart, or just ask the model to "init memory for this repo" — it calls the same tool. |
| Init says `Graph: unavailable` | `codebase-memory-mcp` isn't on your PATH. Install it, or point `OPENCODE_CBM_BIN` at the binary. Scripts are still remembered without it. |
| Stale plugin after an update | opencode caches packages in `~/.cache/opencode/node_modules/`; remove the `@abogartz/opencode-self-improvement` folder there and restart. |
| Reset all memories | Delete `~/.config/opencode/memory/`. |

Implementation details and the testing harness live in [`SPEC.md`](./SPEC.md) for contributors.