---
description: Initialize the code graph and build/test memories for this repo
---
Initialize this repository for durable memory and graph-backed work.

1. Ensure the codebase-memory graph is indexed for this repository.
2. Re-derive build/lint/test/typecheck commands and write them as pattern
   memories (scope = this repo name).
3. Store an init stamp keyed on git HEAD so future sessions can cheaply tell
   whether the repo has drifted.

Call the `memory_init` tool to do this. If the user typed arguments (e.g.
"force"), pass them through: set `force: true` when $ARGUMENTS mentions force,
otherwise run a fresh idempotent init.

Then report concisely: graph status, scripts recorded, and the stamp head.