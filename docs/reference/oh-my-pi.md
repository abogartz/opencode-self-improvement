# Experimental oh-my-pi installation

This branch provides memory tools and selected memory context for **oh-my-pi
19.2.1**, tested with **Bun 1.4.4**. It is an unreleased adapter, not a claim of
support for upstream Pi, other derivatives, or dsh. These changes are not yet in
the published npm release; install from this work branch or a package built from it.

The normal installation registers fourteen memory tools, injects relevant
memories before an agent turn, and appends relevant memories to successful
`read`, `grep`, and `glob` results. It also supplies durable-memory anchors to the
host's compaction summarizer. **Automatic turn-end and compaction capture are
enabled.** They use the host's selected model and credential resolver to propose memories from a
sanitized transcript. Set `autoCapture: false` to disable those extra model calls.
Ask the agent to use `memory_remember` for an explicit save. Writes still pass the
shared write gates; facts about project behavior may require reading the relevant
code first.

## Install from this checkout

With Bun and oh-my-pi installed, run these commands from the checkout:

```sh
bun install --frozen-lockfile
omp plugin install .
omp plugin list
```

For a different working directory, pass the checkout's absolute path instead of
`.`. oh-my-pi treats local-directory installation as a link, so retain that
directory and its dependencies. Restart oh-my-pi after installation or an update.
The package's `omp.extensions` manifest selects the adapter; no `--extension`
argument or hand-written loader is required. OpenCode continues to use the existing
default package entry point.

## Install a packed copy

To try a copy that does not load source or dependencies from the work checkout:

1. From the checkout, run `bun pm pack --filename /absolute/path/memory.tgz`.
2. Create an empty directory for the installation, containing a `package.json`
   with `{"private":true,"type":"module"}`.
3. From that directory, run `bun add --ignore-scripts /absolute/path/memory.tgz`.
4. Run `omp plugin install /absolute/path/to/installation/node_modules/opencode-self-improvement`.

Replace the example absolute paths with paths on your machine; quote paths with
spaces. Keep the installation directory: oh-my-pi links to this installed copy.
The tarball need not remain after dependency installation. This route uses the
ordinary package dependencies and does not install an oh-my-pi SDK into the plugin.

## Share memory with OpenCode

Set `OPENCODE_MEMORY_DIR` to the **same absolute directory** in both hosts' launch
environments. For example, in PowerShell:

```powershell
$env:OPENCODE_MEMORY_DIR = 'C:\Users\YourName\agent-memory'
omp
```

Use the same setting when launching OpenCode. Existing OpenCode memories can be
shared by pointing oh-my-pi at the store OpenCode already uses. Sharing is direct;
there is no import, migration, or separate store per harness.

Use the same local project directory for the first trial. Project memories remain
scoped to their project, and explicit `global: true` memories are eligible across
projects. Normal relevance selection still applies; sharing the store does not
inject every memory into every request. Relocated checkouts and machines have not
been validated by this installation test.

To check the installation, ask oh-my-pi to read a relevant project file and remember
a verified fact. Close it, start a fresh session in the same directory, and ask
`memory_recall` for that fact. Then recall it from OpenCode using the same store.
Use `omp plugin list` to check registration if memory tools are absent.

## Configure the adapter

The normal entry point reads `oh-my-pi.json` from the shared memory directory:
`OPENCODE_MEMORY_DIR`, or `~/.config/opencode/memory` by default. For example:

```json
{
  "autoCapture": true,
  "captureOnCompact": true,
  "injectBudget": 1200,
  "frontierBudget": 3600,
  "pullTools": ["read", "grep", "glob"],
  "pullOutputChars": 512
}
```

Set `OMP_MEMORY_CONFIG` to an absolute path to select a different JSON file.
An absent default file uses shared defaults. An explicitly selected missing file,
invalid JSON, non-object value, or string in place of a boolean fails loading with
a configuration error. Restart after editing; settings are read at startup.
These options apply to oh-my-pi even when OpenCode shares the memory directory.

For a programmatic configuration, create `memory-extension.ts` next to the
installed `opencode-self-improvement` dependency. Explicit `options` override the
JSON settings:

```ts
import { createOhMyPiMemory } from "opencode-self-improvement/oh-my-pi";

export default createOhMyPiMemory({
  options: {
    injectBudget: 1200,
    frontierBudget: 3600,
    contradictionSurface: true,
    pullTools: ["read", "grep", "glob"],
    pullOutputChars: 512,
  },
});
```

Disable the default registration and load this entry point instead:

```sh
omp plugin disable opencode-self-improvement
omp --extension /absolute/path/to/installation/memory-extension.ts
```

Keep the configured entry point next to its installed dependency so the package
import resolves. For a checkout trial, use an absolute import of that checkout's
`src/adapters/oh-my-pi/extension.ts`. Load only one entry point per session.
Restart after changing settings; this is startup configuration, not live editing.
To return to defaults, stop passing `--extension` and re-enable the plugin.

`injectBudget` caps relevance context and each pull; `frontierBudget` caps the
separate open-thread block. Omit either to retain the shared defaults and environment
fallbacks. `pullTools: []` disables contextual pulls; `pullOutputChars: 0` searches
tool arguments without including the output. A narrowed `pullTools` list uses the
host's actual tool names. Failed tool results never receive pulls in this adapter.
The shared selection rules and validation are described in
[options](options.md). Automatic capture uses the session model unless
`captureModel: "provider/model-id"` selects a model in the host's registry.
An unavailable configured model is refused rather than silently falling back.
Set `autoCapture: false` to disable all automatic capture, or
`captureOnCompact: false` to retain turn-end capture only. The
[oh-my-pi README](../../README.oh-my-pi.md) includes an agent-install prompt and
an auto-capture opt-out example.

Both JSON configuration and this configurable entry point are tested through the
installed CLI. The native
`omp plugin config` UI is not connected to these options yet: the public extension
API in 19.2.1 does not expose its plugin-settings reader.

## Native commands

- `/repo-init` derives build, lint, test, and typecheck memories from the current
  repository. `/repo-init force` refreshes the initialization stamp.
- `/memory-report` shows the shared memory status and combined/per-harness activity.
- `/memory` remains reserved for oh-my-pi's built-in memory backend; this plugin
  does not register an alias that would conflict with interactive dispatch.

These commands invoke the shared memory tools directly and display the result
without starting a model turn. All fourteen tools remain available to the agent.
OpenCode's interactive memory panel remains specific to OpenCode.

## Disable or remove

```sh
omp plugin disable opencode-self-improvement
omp plugin enable opencode-self-improvement
omp plugin uninstall opencode-self-improvement
```

Restart the host after changing registration. Uninstalling removes the plugin
registration, not the shared memory store. OpenCode can still read those memories.

## Memory during compaction

Before oh-my-pi summarizes a conversation, the adapter supplies the shared engine's
durable-memory anchor: eligible project/global memories, up to twelve rows and
2,500 characters, with complete lines. This adds context to the host's normal
summarization requests, without a separate memory model call or a replacement
summary. It asks the summarizer to retain the facts; it cannot guarantee what a
model will write.

Delivery is verified for ordinary LLM summarization. Snapcompact, handoff, and
provider-native compaction paths are outside this integration proof; some host
paths bypass the hook's context.

Preparation supplies the anchor and snapshots the transcript, model, and credential
resolver. After the host commits compaction, automatic capture mines that snapshot
through the shared gates; it never mines the replacement summary as if it were the
original conversation. This also works when another extension supplies the summary.
The completion notification performs bookkeeping and refreshes memory context for
the next turn. Cancelling after preparation starts no capture and leaves a retry
usable. The capture model call runs independently of the summarizer.

In 19.2.1, registering a pre-compaction hook makes the host use compaction paths
that honor extension hooks instead of some background optimizations. Setting
`captureOnCompact: false` omits that snapshot hook while retaining memory anchors.

In oh-my-pi 19.2.1, compaction-hook results are **not merged**: the last returned
result wins. Multiple extensions customizing compaction can replace each other's
context, prompt, and preserved data. A full replacement summary also bypasses the
anchor hook. The integration tests cover normal summarization, cancellation and
retry, empty stores, a replacement summary, and a later hook replacing our result.

## Statistics across harnesses

Run `/memory-report` or ask the agent to call `memory_status` for combined activity
and separate harness totals. OpenCode's `/memory-report` reads the same records.
Retrieval credits and capture activity carry `oh-my-pi` attribution; the memory
inventory remains shared. Historical records without attribution count as
OpenCode. The adapter snapshots usage from finalized assistant records at session
load, agent completion, session transitions, and cooperative shutdown. Streaming
updates are not added as separate receipts; repeated snapshots and a process
restart retain one accounting identity. Input, cache reads/writes, and output
come from the host records. When every receipt reports a reasoning count, it is
separated from output. Otherwise output includes reasoning and the split remains
unknown. No valid receipts means **not reported**.

These are retained session-history totals, not billing. They include retained
off-branch messages; a new fork can inherit earlier messages, so totals across
forks can overlap. Pruning or replacing history can reduce a session snapshot.
Auxiliary `model_usage` records, subagent tool totals, and separate memory-capture
calls are excluded. Capture estimates are reported separately. See
[report coverage and retention limits](surfaces.md#combined-and-per-harness-activity).

## Acceptance coverage

The supported integration includes all fourteen tools, automatic context,
turn-end capture, ordinary LLM compaction, native commands, usage snapshots and
shared project/global storage. It uses the shared engine's policy and gates.

| Behavior | Verification |
| --- | --- |
| Tools, validation, grounding, visibility, selected injection and session-only facts | The same nine runtime conformance scenarios run for the reference host, OpenCode and oh-my-pi. |
| Prompt/context delivery | The native combined prompt hook returns system context; the observation hook carries no system sink. Clipped and duplicate tool-result copies cannot invent credit. |
| Failed tests and recovery | Numeric nonzero shell exits reach shared failure/recovery tracking. Unit regressions and the real SDK dispatcher verify error flags and receipts. Errors without an attested exit and failed reads cannot invent successful evidence. |
| Capture and credentials | Real SDK local and registered providers; isolated scrubbed completion; malformed, aborted and tool-call answers refused. |
| Compaction and session changes | Real SDK ordinary/custom/cancelled summaries, original-transcript capture, branch/tree/switch/clear identity retirement. |
| Shutdown | Bounded answered/unanswered capture and pending writes; common conformance rejects answers arriving after completed disposal. |
| Installation and sharing | Packed CLI installation, restart, automatic capture, commands, per-harness usage, and bidirectional OpenCode sharing with project/global isolation. |

Run `bun run test:simulator` for the common contracts without installing a host.
Run `bun run test:oh-my-pi` after installing the pinned integration dependencies
for real SDK/CLI checks. CI runs both unit and SDK suites on Linux and Windows.
The shell-dispatch fixture returns native exit metadata without executing a real
shell; it verifies host event transport, while the pinned bash implementation is
the source of that metadata shape. These tests establish the supported scope;
the limitations below remain explicit.

## Current limits

- The packaged entry point supplies tools, context, native commands, and automatic
  turn-end and compaction capture. It does not port OpenCode's interactive panel.
- Pull usage is recorded when the adapter's `context` hook observes complete
  memory rows in the matching tool result. Earlier tool-result transformations
  are accounted for. Later context/provider transformations, request cancellation,
  and provider rejection remain outside that observation; a receipt is not proof
  of model consumption. Prompt-context accounting still observes placement at
  `before_agent_start`.
- Capture uses an isolated completion with no tools or conversation history beyond
  the sanitized prompt. Errors, aborted/truncated responses, and tool calls are
  refused. Generation has a 20-second abort deadline. Cooperative shutdown gives
  pending capture up to 500 ms before cancellation and the shared bounded write
  drain; slow or forcibly terminated captures can be lost. Runtime-registered
  providers and session branch/tree/switch transitions are covered by real SDK
  tests. Host cost budgets and live hosted-provider behavior remain unverified.
- CLI installation, discovery, configuration, restart, recall/injection, project isolation,
  uninstall, and OpenCode interoperability are tested with a local scripted model.
  SDK tests check outgoing contextual pulls, clipped results, and disabled pulls.
  They also inspect compaction requests for scoped anchors and caller instructions.
  Interactive UI behavior and hosted-provider behavior are not established by
  those tests.

For the SDK contracts and testing instructions, see
[development notes](../internals/development.md#oh-my-pi-adapter).
