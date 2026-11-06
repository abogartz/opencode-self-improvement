---
description: Initialize build/test memories for this repo (code graph is opt-in)
---
Initialize this repository for durable memory.

1. Re-derive build/lint/test/typecheck commands and write them as pattern
   memories (scope = this repo name).
2. Store an init stamp keyed on git HEAD so future sessions can cheaply tell
   whether the repo has drifted.

Code-graph indexing is opt-in and off by default (`Graph: disabled`); nothing
reads the index. Only build it if the user asked for it, by setting
`OPENCODE_MEMORY_GRAPH=1` before the call.

Call the `memory_init` tool to do this. If the user typed arguments (e.g.
"force"), pass them through: set `force: true` when $ARGUMENTS mentions force,
otherwise run a fresh idempotent init.

Then report concisely: graph status, scripts recorded, and the stamp head.