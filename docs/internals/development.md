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
| `bun run test:e2e` | `smoke`, `smoke-stable` | `smoke` only |
| `bun run test:oh-my-pi` | `oh-my-pi` on Linux and Windows | reports separately |

`tsc --noEmit` has no check of its own in CI — it runs inside `lint`, so a green `lint` silently implies a green typecheck.

`bun run lint` checks lint rules and TypeScript/TSX formatting, and CI calls the same command. Lint warnings stay advisory; formatting differences fail the check. Markdown commands, prose, JSON data and historical benchmark records are outside the formatter's scope.

The test scripts run files across at most four worker processes with Bun's file isolation. To reproduce an order-dependent failure the way it would appear in one shared process, run `bun test ./test/` or `bun test ./e2e/ --timeout 240000` directly.

## Host interface and reference harness

The [host contract](host-contract.md) specifies the ports, semantic obligations,
capabilities and shared project/global ownership rules. `src/runtime/` contains
the shared setup, lifecycle and capture policy; `test/simulator/` implements the
same interface with controlled failures and event ordering. Run
`bun run test:simulator` without installing another harness or using a model
service. These tests also run in the ordinary unit suite.

The production OpenCode adapter lives in `src/adapters/opencode/`, including
its terminal UI. Its plugin supplies the same host interface as the reference
implementation. Adapter conformance tests run the real engine with both hosts;
the package keeps its existing OpenCode entry points.

## oh-my-pi adapter

The oh-my-pi consumer lives in `src/adapters/oh-my-pi/`. Its native-callback driver
in `test/adapters/oh-my-pi-runtime-driver.ts` runs the reusable runtime assertions
in `test/host/runtime-contract.ts`, alongside the OpenCode and reference bindings.
The combined prompt/system hook uses the suite's combined-delivery profile;
OpenCode retains its separate-hook assertions. Every binding checks late answers
after disposal, including a host's bounded grace period. The fixture supplies
the capture transcript/model binding and scripted generation; SDK tests exercise
the normal packaged completion and credential-resolution path.

Install its pinned
integration dependencies with
`bun install --cwd integration/oh-my-pi --frozen-lockfile`, then run
`bun run test:oh-my-pi` for SDK contracts, capture, native commands, packed
installation and cross-host storage tests. These checks use real hosts with local
scripted providers; no provider API key is needed. The shared reference harness
remains independent of both vendor SDKs.

## What the smoke suite boots

Both smoke jobs run the same suite and print the exact OpenCode CLI version.
`smoke` checks the compatibility baseline, OpenCode 2.0.26. `smoke-stable` is
informational and pins a stable OpenCode v2 release in the CI workflow. Update
that pin by PR. Before retiring the baseline, document the new minimum
supported host and announce how long the existing coverage will remain.

`e2e/` boots the **real opencode CLI** against each candidate in a fully isolated instance (fresh config, fresh db, fresh memory store, empty `HOME`) driven by a scripted OpenAI-compatible fake model — no API keys. It covers loading from the source tree and from the packed npm artifact installed runtime-deps-only, plus BDD flows for remember, recall, exact and near duplicates, ungrounded claims, and forget. Needs `opencode` on `PATH` locally, or set `OPENCODE_BIN`. A `test-windows` leg also runs the suite on Windows; it reports without gating merges.

## The published surface is `package.json`

`exports` is the only import surface other code can reach (`.` → `index.ts`, `./tui` → `src/adapters/opencode/tui/panel.tsx`, `./oh-my-pi` → `src/adapters/oh-my-pi/extension.ts`); `files` is the packaging list. `files` covers `src/`, so anything reachable from an `exports` target ships, but a new top-level file or directory — or anything the plugin reads at runtime outside those paths — must be added to `files` or it works from the checkout and vanishes from the npm artifact. The packed-artifact load in `e2e/` turns that miss red.

## Upstream Pi adapter

The Pi binding is `src/adapters/pi/`, tested against upstream Pi 1.7.0 under
Bun 1.4.4. `src/adapters/pi-family/` holds the capture queue, text decoder,
delivery, usage and configuration mechanics shared with oh-my-pi. Native
lifecycle and model/compaction bindings remain in each adapter.

`test/runtime/pi-runtime-contract.test.ts` runs the same eight shared scenarios.
It uses controlled capture and summary bindings, requiring no live host.
`integration/pi/` separately compiles against the pinned SDK and exercises actual
Pi sessions, commands, provider routing, usage, shutdown, compaction, installation,
and cross-host storage. Run `bun install --cwd integration/pi --frozen-lockfile`
and install `integration/oh-my-pi` dependencies, then `bun run test:pi`. The cross-host cases require OpenCode; `OPENCODE_BIN` can
select its executable. See [installation and limits](../../README.pi.md).
