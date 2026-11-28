# OpenCode adapter parity review

The comparison baseline is main `7aa710ca9f7cf66c687e1c75cb19c7fe658ee2b5`
(0.37.4). The interface/reference-host layer can land first with the existing
OpenCode glue. The OpenCode adapter layer replaces that glue; it does not keep a
second implementation of the memory engine. This is evidence for maintainer
review, not a claim that the broader multi-harness MVP is accepted.

## One production route

`index.ts` → `src/index.ts` → `src/adapters/opencode/plugin.ts` →
`createOpenCodeMemoryHost` → `setupMemory`.

Only the adapter registers native hooks or subscribes to native events. Those
hooks translate payloads and call the shared lifecycle/capture ports. Selection,
write gates, capture policy, usage accounting and cleanup live in the shared
runtime. The old `src/events.ts`, `src/core/host.ts`, `src/capture/runtime.ts`,
`src/capture/transcript.ts` and `src/identity/host-events.ts` implementations are
removed by the adapter layer. Compatibility exports at `src/index.ts` forward to
the same implementation.

## Preserved behavior and evidence

| Behavior | Shared/reference evidence | OpenCode evidence |
| --- | --- | --- |
| Fourteen tools, raw validation, write gates, corrections/deletion | `test/host/tool-contract.ts`, `test/host/runtime-contract.ts`, existing tool/store suites | `test/adapters/opencode.test.ts`, `e2e/characterization.test.ts`, `e2e/store.test.ts` |
| Session/project identity and project/global sharing | Common runtime contract, `test/simulator/scenarios.test.ts`, identity suites | `test/runtime/opencode-conformance.test.ts`, `e2e/shared-store.test.ts`, recorded event fidelity |
| Relevant system context and tool-result pulls | Common runtime contract, injection/receipt suites | Native context/result translation tests; real `e2e/pull-delivery.test.ts` and `e2e/pull-attribution.test.ts` observe outgoing requests |
| Turn-end capture, sanitized prompt, transcript provenance and cursors | Common runtime contract, capture/security suites | `test/adapters/capture.test.ts`, `test/adapters/transcript.test.ts`, real capture/compaction tests |
| Compaction anchor and lifetime counters | Common runtime contract, epoch/lifecycle suites | Native combined-hook translation, `e2e/compaction.test.ts` |
| Cumulative and per-message usage | Common runtime contract, `test/status/usage-subscription.test.ts` | Native event decoder; recorded usage fixtures and status tests |
| Registration, failed setup, late callbacks, bounded cleanup | Shared setup/reference fault controls | `test/adapters/lifecycle.test.ts`, `test/adapters/plugin.test.ts`, `e2e/host-teardown.test.ts` |
| Commands, default plugin loading and terminal entry | Existing command/init tests | `test/init/command.test.ts`, source/packed loading and TUI JSX checks in `e2e/load.test.ts` |

The common runtime suite runs unchanged assertions through both the reference
host and the production OpenCode adapter. The OpenCode driver supplies native
payloads; it does not bypass translation by calling shared handlers. Its event
bus broadcasts to both native subscribers and waits for handling acknowledgements.
Vendor-only payload variants remain in adapter tests. The reference host also
exercises capability absence, failures, concurrency and split compaction, which
OpenCode's combined hook cannot emulate.

## Intentional changes

- Disposal stops new callbacks immediately, even when native hook removal is
  asynchronous. Already-admitted work retains its original identity and sink;
  abandoned capture answers cannot write later.
- Harness statistics supplement combined statistics. Existing unattributed
  records count as OpenCode. Harness attribution does not partition memories.
- Windows short and long directory names identify the same project; legacy keys
  remain visible only to that same canonical directory.
- The capture port accepts asynchronous default-model resolution. OpenCode uses
  the installed SDK's asynchronous API while retaining its older getter shape.
  Ownership and turn boundaries freeze before that await, and disposal during
  lookup prevents subsequent capture work.
- The adapter supplies the capture abort signal as a request option, but the
  pinned `@opencode/plugin` 2.0.32 Promise adapter drops that second argument.
  In-flight generation is therefore not cancelled by this SDK path. The shared
  runtime's abandonment checks prevent late answers from writing after disposal;
  they do not stop provider execution or billing. Already-aborted requests are
  rejected locally before calling the SDK.
- Viewer test teardown awaits the child process before removing its temporary
  files, eliminating the observed Windows `EBUSY` fixture races.

The plugin context must structurally satisfy the installed SDK type without an
`unknown` cast. This catches declaration drift in addition to runtime payload
tests. No tool behavior or OpenCode feature is intentionally removed.

## Reproducible checks and limits

Run `bun run typecheck`, `bun run lint:comments`, `bun run lint`, `bun run test`
and `bun run test:e2e`. The latter needs a real OpenCode binary and uses an
isolated store/configuration plus scripted providers. No live provider key is
needed. `bun run test:simulator` exercises the common engine and both conformance
bindings locally without installing OpenCode.

CI runs unit/adapter tests on Linux and Windows, and the real OpenCode suite on
Linux with pinned versions 2.0.26 and 2.4.1. A Windows local control using Bun
1.4.4 and OpenCode 2.4.2 reproduces the baseline standalone-shutdown failure;
its assertion remains enabled. The independent reproduction and passing
cooperative server control are in `e2e/repros/standalone-cleanup/` and
`e2e/host-teardown.test.ts`. See
[OpenCode #66868](https://github.com/anomalyco/opencode/issues/66868).

Matching tests and observed requests support parity within these exercised
boundaries. They do not prove interactive terminal behavior, arbitrary provider
authentication/billing, cache acceptance, or durability after forced process
exit. An incomplete receipt after forced exit has an unknown outcome; it does
not by itself prove that a memory write was lost. Current run counts and commit
IDs belong in the PR descriptions so this contract does not become a stale log.
