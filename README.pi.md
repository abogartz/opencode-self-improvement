# Memory for upstream Pi

The upstream Pi adapter provides fourteen memory tools, relevant context,
automatic turn-end and compaction capture, `/repo-init`, `/memory-report` and
`/memory`, and combined/per-harness statistics. It uses the same memory engine
and store as OpenCode and oh-my-pi.

Development baseline: **upstream Pi 1.7.0**
(`@earendil-works/pi-coding-agent`, from `earendil-works/pi`) and **Bun 1.4.4**.
The older `@mariozechner/pi-coding-agent` package and earlier Pi releases have
not been validated. This adapter is unreleased; use this checkout or a packed
copy, not the existing npm release of opencode-self-improvement.

## Run Pi with Bun

This project's shared engine requires Bun, including `bun:sqlite`. Start Pi's
JavaScript CLI with Bun. The usual Node-based `pi` launcher cannot load this
adapter; its entry point reports that requirement before importing the engine.

For a global installation of `@earendil-works/pi-coding-agent@1.7.0`, use:

```powershell
$piCli = Join-Path (npm root -g) '@earendil-works/pi-coding-agent/dist/bundle/cli.js'
bun $piCli --version
```

On macOS/Linux:

```sh
PI_CLI="$(npm root -g)/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
bun "$PI_CLI" --version
```

For a local Pi installation, use that installation's absolute
`node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` path instead.
Use this Bun invocation for both installation commands and ordinary sessions.

## Install this checkout

From the checkout, with `$piCli` set as above:

```powershell
bun install --frozen-lockfile
bun $piCli install .
bun $piCli list
bun $piCli
```

Use `bun "$PI_CLI"` in place of `bun $piCli` on macOS/Linux. Pi links a local
directory, so retain it. The package's `pi.extensions` manifest selects the Pi
adapter; its `omp.extensions` manifest separately selects oh-my-pi. OpenCode
keeps the default package entry point. Restart Pi after installing or updating.

For a packed copy: run `bun pm pack --filename /absolute/path/memory.tgz` in
this checkout, create an installation directory with a private `package.json`,
and run `bun add --ignore-scripts /absolute/path/memory.tgz` there. Then run
`bun $piCli install /absolute/path/to/installation/node_modules/opencode-self-improvement`.
Keep that installation directory. Host SDKs are development dependencies and
are not shipped as runtime dependencies of the plugin.

## Share memories and configure capture

Set `OPENCODE_MEMORY_DIR` to the same absolute directory for Pi, oh-my-pi and
OpenCode. Launch them in the same project directory to share project memories;
explicit global memories are eligible across projects. Normal relevance and
write gates still apply. Harness attribution distinguishes activity and usage,
not memory ownership. Historical unattributed activity continues to count as
OpenCode.

```powershell
$env:OPENCODE_MEMORY_DIR = 'C:\Users\YourName\agent-memory'
bun $piCli
```

Pi reads `pi.json` in that memory directory (default:
`~/.config/opencode/memory/pi.json`). Set `PI_MEMORY_CONFIG` to an absolute path
to select another file. Settings are validated at startup and do not affect the
other adapters. For example:

```json
{
  "autoCapture": true,
  "captureOnCompact": true,
  "injectBudget": 1200,
  "frontierBudget": 3600,
  "pullTools": ["read", "grep", "find"],
  "pullOutputChars": 512
}
```

**Automatic capture is enabled by default.** It makes an additional model call
using the current model and Pi's configured provider/auth registry. The shared
engine scrubs credentials from public transcript text; thinking blocks and raw
tool results are excluded. Normal provider charges apply. Set `autoCapture` to
`false` to disable it, or `captureOnCompact` to `false` to retain turn-end capture
only. `captureModel: "provider/model-id"` selects a registered capture model;
an unavailable selection is refused. See [shared options](docs/reference/options.md).

Capture renders the most recent 40 user turns in the selected window, retaining
source-message positions for delta capture. Earlier branch history kept by Pi
after compaction does not prevent new facts from reaching capture. Provider failures
report fixed diagnostic categories; raw provider error messages are never included
in the adapter's console warnings or evidence because they may echo credentials.

For programmatic configuration, an extension next to the installed package can
export `createPiMemory({ options: { autoCapture: false } })`, imported from
`opencode-self-improvement/pi`. Remove the default registration before loading
that file with `-e`; load only one memory entry point per session.

## Verify or remove

1. Run `/memory-report` or `/memory`, then `/repo-init` if desired.
2. Have Pi read a project file and explicitly save a verified fact with
   `memory_remember`.
3. Start another session in the same project and recall it with `memory_recall`.
4. Recall it from OpenCode or oh-my-pi using the same store. Check another project
   to confirm that project memories stay scoped and explicitly global ones remain
   eligible.

Remove a local registration with `bun $piCli remove /absolute/path/to/installed/package`,
using the same source path shown by `bun $piCli list`. Removal leaves the store
intact. Restart Pi after registration changes.

An agent can follow this installation request:

> Install the upstream Pi adapter from this checkout. Read README.pi.md first.
> Verify the Pi and Bun versions and locate the installed Pi CLI. Run Pi through
> Bun, register this package using its Pi manifest, and retain its directory.
> Use my selected existing memory directory for shared project/global memories.
> Verify tools and recall with an isolated test fact. Report the selected store,
> configuration, and whether automatic capture is enabled.

## How this relates to oh-my-pi

The adapters share the runtime, all tool handlers, gates, store, capture queue,
public-text transcript decoder, content-delivery helpers, usage folding and
configuration parsing. Their native event wiring and model calls stay separate:

| Boundary | Pi 1.7.0 | oh-my-pi 19.2.1 |
| --- | --- | --- |
| Package entry | `pi.extensions`, `/pi` | `omp.extensions`, `/oh-my-pi` |
| Prompt | String; user/custom trigger distinction | Array; prompt/revive distinction |
| Session replacement | Teardown and rebuild; `session_start` | Switch/clear/branch callbacks |
| Shell exits | `structuredContent.exit_code`; bash and PowerShell | `details.exitCode` |
| Capture model | Host registry `streamSimple`, request-time authentication | Host SDK `completeSimple`, bound credential resolver |
| Compaction anchors | Prepared summary context, native summarization | `session.compacting` extra context |
| Reasoning usage | `usage.reasoning` | `usage.reasoningTokens` |

Pi's `find` maps to the shared engine's `glob` operation; `powershell` maps to
`shell`. Pull configuration accepts native Pi names. Structured tool output and
image blocks survive appended memory context.

## Validation and limits

The same nine runtime contract scenarios run against the reference harness,
OpenCode, oh-my-pi and Pi. Unit tests need no running host. The pinned integration
suite exercises Pi's actual loader, dispatcher, provider registry, lifecycle,
compaction and CLI against a local scripted model:

```sh
bun install --cwd integration/pi --frozen-lockfile
bun install --cwd integration/oh-my-pi --frozen-lockfile
bun run test:pi
```

Cross-host checks also require the OpenCode executable (select it with
`OPENCODE_BIN` if needed). CI runs on Linux and Windows. These tests establish
local scripted-provider behavior; live hosted-provider billing and interactive
terminal rendering are not covered.

Pi does not have oh-my-pi's extra-context compaction hook. The adapter adds memory
anchors as summary-only context in the preparation payload, then leaves Pi's
native summarizer in control of model/auth routing, retry policy and file tracking.
It carries forward standard file details from older extension-generated summaries.
A later extension can replace or cancel summarization before Pi makes its request.
Capture starts only after successful compaction and mines the original snapshot,
excluding the added memory context. No synthetic entry is added to session history.

Turn-end capture starts at Pi's `agent_settled` boundary, after retries and queued
continuations finish. It reads the active branch's original message entries,
preserving cursor slots across user turns and excluding synthetic summaries.
Aborted runs do not start capture. Generation runs in the background with a
20-second deadline. The shared five-minute cooldown applies independently to
turn-end and compaction capture; an event does not guarantee another model call.
Cooperative shutdown grants up to 500 ms for capture, then cancels outstanding
work and uses the shared bounded write drain. Forced termination and slow capture
can still lose pending work; durable abandonment accounting remains separate.
Use the public `AgentSessionRuntime.dispose()` lifecycle when embedding Pi: bare
`AgentSession.dispose()` does not emit extension shutdown.

Context receipts describe placement observed by the extension, not proof of
provider consumption. Changing selected system context can change the cached
conversation prefix. Usage reports describe retained assistant history, including
off-branch entries, not billing; capture estimates are separate. OpenCode's
interactive memory panel remains specific to OpenCode.
