# Development internals

What the local commands really run, what the smoke suite boots, and how the
published npm surface is decided. The commands themselves and the BDD-first
rule stay in the README.

## Local command to CI job

| Local command | Where it runs in CI | Gates a merge |
| --- | --- | --- |
| `bun run typecheck` | inside the job named `lint` | yes, under that name |
| `bun run lint` | `lint` | yes |
| `bun run test` | `test`, re-run in `test-windows` | `test` yes; `test-windows` reports only |
| `bun run test:e2e` | `smoke` | yes |

`tsc --noEmit` has no check of its own in CI — it runs inside `lint`, so a green `lint` silently implies a green typecheck.

`bun run lint` checks lint rules and TypeScript/TSX formatting, and CI calls the same command. Lint warnings stay advisory; formatting differences fail the check. Markdown commands, prose, JSON data and historical benchmark records are outside the formatter's scope.

The test scripts run files across at most four worker processes with Bun's file isolation. To reproduce an order-dependent failure the way it would appear in one shared process, run `bun test ./test/` or `bun test ./e2e/ --timeout 240000` directly.

## What the smoke suite boots

`e2e/` boots the **real opencode CLI** against each candidate in a fully isolated instance (fresh config, fresh db, fresh memory store, empty `HOME`) driven by a scripted OpenAI-compatible fake model — no API keys. It covers loading from the source tree and from the packed npm artifact installed runtime-deps-only, plus BDD flows for remember, recall, exact and near duplicates, ungrounded claims, and forget. Needs `opencode` on `PATH` locally, or set `OPENCODE_BIN`. A `test-windows` leg also runs the suite on Windows; it reports without gating merges.

## The published surface is `package.json`

`exports` is the only import surface other code can reach (`.` → `index.ts`, `./tui` → `src/tui/panel.tsx`); `files` is the packaging list. `files` covers `src/`, so anything reachable from an `exports` target ships, but a new top-level file or directory — or anything the plugin reads at runtime outside those paths — must be added to `files` or it works from the checkout and vanishes from the npm artifact. The packed-artifact load in `e2e/` turns that miss red.
