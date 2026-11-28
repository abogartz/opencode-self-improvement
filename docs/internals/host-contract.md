# Host interface and reference implementation

`src/host/` defines the internal interface supplied to `setupMemory` in
`src/runtime/setup.ts`. The shared runtime owns tools, write gates, selection,
capture policy, receipts and disposal. The programmable host in `test/simulator/`
is the reference implementation: it runs that real engine without a vendor SDK.

The existing OpenCode entry point and translators remain in `src/index.ts`,
`src/core/host.ts`, `src/events.ts`, `src/capture/runtime.ts`,
`src/capture/transcript.ts`, `src/identity/host-events.ts`, `src/init/ensure.ts`
and `src/inject/host-delivery.ts`, with the terminal surface in `src/tui/`.
Their extraction into a production adapter
is a separate change. There is no second harness, SDK dependency, package export
or harness-specific extension in this foundation.

## Required semantics

- **Tools:** register the fourteen shared definitions once, retain their JSON
  schemas, pass raw arguments to the shared validator, and return its text.
  Host-native command installation and payload translation stay at the boundary.
- **Identity:** capture session/call IDs and the absolute project directory before
  awaiting work. IDs must be distinct between concurrent host instances unless
  they identify the same transcript. Transcript replacement must retire old
  grounding and frozen context, even when the vendor retains its session ID.
  Unknown ownership must not borrow another session's project.
- **Storage:** ownership is project/global, never harness-specific. The same store
  and project identity share eligible memories; relevance selection still applies.
  Windows short and long directory names resolve to one canonical identity, and
  old path keys remain visible to that same directory. Root configuration is
  process-wide; separate roots require separate processes. Bun and local
  filesystem/git access remain requirements.
- **Lifecycle:** report normalized prompts, tool calls/results, identity, usage,
  context observations and compaction through `LifecycleHandlers`. Callbacks may
  overlap; retain the event's original identity and sink across awaits. Combined
  compaction and separate `prepare`/`complete` phases are supported. Cancelled
  preparation must not finalize session bookkeeping.
- **Injection:** append the exact returned text to the offered surface. A missing
  sink means no delivery. Observe results independently by session/call ID;
  clipped, duplicated or quoted fragments cannot invent delivery credit. Hook
  observation does not prove provider acceptance after later transformations.
- **Capture:** expose turn-end events, normalized transcripts and isolated text
  generation, or omit unavailable methods. Preserve transcript slots and genuine
  user/assistant provenance; exclude thinking and synthetic/tool content. Bind
  model and credentials to the original session before awaits. Generate from
  only the supplied scrubbed prompt, without ambient tools or conversation.
  Forward cancellation through the host's supported request API and reject
  unsuccessful completions. Request cancellation does not prove that the remote
  provider stopped generating or billing. The shared runtime must also reject
  abandoned late answers when a host cannot cancel the underlying operation.
  Shared policy owns
  cooldowns, model selection, redaction, write gates and bounded abandonment.
- **Usage:** distinguish cumulative versus incremental receipts and update the
  same message instead of double-counting streaming revisions. Unknown reasoning
  tokens remain unknown. Token receipts are not a billing ledger or delivery proof.
- **Shutdown:** stop admission synchronously, release registrations and join the
  cleanup promise when the host permits it. Answered capture has a bounded drain;
  unanswered work can be abandoned. Forced exit may bypass every callback.

## Capabilities and attribution

The useful baseline is tools, resolved ownership, prompt observations and
automatic relevance-selected context delivery. A host providing only manual
memory tools is degraded, not a complete integration. The current engine uses
the system sink for its automatic digest; tool-result pulls additionally need
tool events, a writable result and independent outgoing-result observations.
An alternative context surface needs an explicit contract extension and tests;
declaring a capability alone cannot supply one.

Transcript/session directory lookups are alternative identity sources. Combined
and split compaction are alternative lifecycle mechanisms. Capture, usage receipts
and native commands are extensions: an adapter may declare them unavailable,
but implementing them entails every corresponding obligation above. For OpenCode,
completion includes all currently supported features, including automatic capture,
compaction, usage, commands and its native terminal surface.

`MemoryRuntime.capabilities` reports optional event, tool, context and usage
surfaces, compaction shape, cache placement and shutdown semantics. Capture
availability comes from actual optional methods, not diagnostic labels. Method
availability does not establish credentials, a selected model or successful
delivery. Each callback still checks its actual sink.

The legacy OpenCode integration declares system text ahead of conversation text:
changing it changes that prefix. Its cooperative shutdown is best-effort and
forced exit offers no cleanup guarantee. The simulator declares cache placement
unknown because it has no provider; cooperative disposal is awaited. These
declarations describe behavior rather than enabling a separate policy per host.

`MemoryHost.harness` attributes activity to a stable adapter identifier. The shared
runtime binds attribution at callback entry and retains it across awaits. Global
and per-harness statistics use the same store; attribution never partitions
ownership. Historical unattributed records count as OpenCode for compatibility.

## Tool obligations

No shared tool handler imports a vendor SDK. These obligations remain shared:

| Tool | Required context or behavior |
| --- | --- |
| `memory_remember` | Writer ownership and normalized engagement evidence. |
| `memory_update` | Stable reader/writer identity throughout replacement and gates. |
| `memory_forget` | Selector, reason and project/global authorization. |
| `memory_recall` | Reader identity and call ID for visibility and use accounting. |
| `memory_list` | Shared inventory/filter semantics; listing is not injection. |
| `memory_undo` | Snapshot and write ownership checks against the local store. |
| `memory_evidence` | Reader-scoped evidence and original operation IDs. |
| `memory_merge_review` | Candidate ownership, reason and gate checks. |
| `memory_export` | Existing containment rules for local export paths. |
| `memory_import` | Local artifact access, importer ownership and replay gates. |
| `memory_decay` | Dry-run/default behavior and scoped mutation. |
| `memory_consolidate` | Shared store analysis, without a host model call. |
| `memory_init` | Actual local project tree for script discovery and git stamps. |
| `memory_status` | Normalized usage/context evidence; aggregate store counts remain machine-wide. |

Remaining inherited assumptions include engagement tools named
`read/grep/glob/edit/write/bash/shell`, their command/path/query arguments and exit
metadata, default pull tools `read/grep/glob`, and transcript positions counting
source slots. Adapters must normalize genuine semantics rather than relabel
failed operations as successful evidence. Default paths and some status wording
retain OpenCode names for compatibility. This is not a public adapter SDK or
proof that an arbitrary harness satisfies the protocol.

## Reference host and verification

The reference host is the local development and maintenance substitute for every
supported adapter. It covers the union of shared ports and their supported
variants without installing any production harness. Its capability profiles can
remove surfaces; command/tool/lifecycle registration, both directory lookups,
transcript reads, default-model resolution, generation and disposal can be paused,
failed or answered out of order. Model resolution is replaceable per session, and all lifecycle handlers,
including errors, are reachable. Late model answers remain controllable after
abort so the engine's abandonment protection is tested independently of a
cooperative provider.

`test/host/runtime-contract.ts` is the reusable behavioral suite. Each production
adapter supplies a stimulus driver that translates inputs to its native payloads;
the assertions and shared engine are unchanged. The reference binding lives in
`test/runtime/reference-conformance.test.ts`. The suite covers registration and
validation of all fourteen tools, grounding, project/global visibility, automatic
selection, identity moves, absent delivery sinks, compaction anchors, cumulative
usage revisions, pull-delivery receipts, capture and late-answer cleanup.

CI must run the shared tests through every supported adapter, plus real-host
integration checks for registration, actual request delivery and packaged loading.
The reference suite makes local development independent of those installations;
it does not replace their CI checks. Pin host versions and record the tested
versions when investigating drift. Keep existing behavioral assertions when
adapting test calling methods. Native UI and provider/transport behavior remain
host-specific acceptance checks.

Run `bun run test:simulator` for controlled event ordering, missing capabilities,
held/failed generation, clipped delivery, concurrent identities, split compaction,
statistics and teardown. The reference host records attempted and delivered
text; it cannot establish exact provider bytes, cache acceptance or forced-exit
durability. Its tests belong with this interface, not with a production adapter.

`test/host/tool-contract.ts` checks the shared validator, write gates, ownership,
correction and deletion. `test/runtime/setup.test.ts` checks complete initialization,
shared project/global storage, selected injection and cleanup. Existing OpenCode
E2E checks remain the compatibility check for its retained entry point; production
adapter-specific conformance tests accompany the separate extraction.

The known Windows standalone cleanup assertion remains enabled; the independent
reproduction is filed as [OpenCode #66868](https://github.com/anomalyco/opencode/issues/66868).
Loss accounting needs durable admission/completion receipts and explicit observed
abandonment reasons. An unfinished receipt after forced exit has an unknown
outcome, not necessarily a lost memory: the store write may have succeeded first.
