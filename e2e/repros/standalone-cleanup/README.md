# OpenCode standalone exit skips plugin cleanup on Windows

Discovered while developing [opencode-self-improvement](https://github.com/abogartz/opencode-self-improvement/pull/560). This reproduction is independent of that project's plugin, dependencies, and test harness.

The entire probe is `plugin.ts`: it synchronously records setup and returns an asynchronous cleanup function that records entry, awaits 10 ms, and records completion. It has no event subscriptions, tools, memory storage, or pending background work. The short wait demonstrates whether the host awaits the returned cleanup function.

## Run

Requires Bun and an OpenCode v2 executable. Verified with Bun **1.4.4** and OpenCode **2.4.2** and **2.0.26** on Windows x64 (`10.0.26200`). No dependency installation, API keys, or model account are required.

Copy this directory anywhere, then run:

```powershell
bun repro.ts
```

The runner finds OpenCode on `PATH` and unwraps its standard Windows npm launcher. To select a particular build or bypass a different launcher:

```powershell
bun repro.ts "C:\path\to\opencode.exe"
```

`repro.ts` serves a fixed `done` response over a loopback OpenAI-compatible endpoint. Each case gets fresh configuration, home, data, cache, and temporary directories. Existing OpenCode configuration and credentials are not inherited. The runner loads only the probe plugin.

It runs two cases:

1. `opencode run --standalone --format json -m fake/scripted "Reply with done."`
2. `opencode serve --stdio --hostname 127.0.0.1 --port 0`, followed by the same turn using `--server <ready-url>`. After the client exits, the runner closes the server's stdin ownership lease and waits for server exit.

Both cases must return the expected model answer with exit code zero. A watchdog termination, startup error, failed turn, or failed cooperative control makes the result **inconclusive**, not a reproduced bug.

## Expected and observed

Expected: both shutdown paths invoke and await the plugin's returned cleanup function, producing `setup, cleanup-start, cleanup-end` before the host exits.

Observed on Windows with OpenCode 2.4.2:

```text
opencode v2.4.2; Bun 1.4.4
win32 10.0.26200 x64
Receipts and process logs: <temporary directory>
standalone: CLI exit=0, answer=done
cooperative: CLI exit=0, answer=done
standalone receipts: setup
cooperative receipts: setup, cleanup-start, cleanup-end
REPRODUCED: standalone exited without completing plugin cleanup.
```

The synchronous `cleanup-start` receipt is absent: the standalone case does not even enter cleanup. The cooperative control loads the same plugin and completes its asynchronous cleanup. This isolates the shutdown path without relying on delayed event handlers or the memory plugin's behavior.

Both versions produced this result from an extracted bundle outside the project checkout, without `node_modules`. A separate deliberately broken cleanup callback made the runner return **2**, confirming that a failed control cannot be reported as a reproduced bug.

Runner exit codes:

- **1:** standalone cleanup is missing or incomplete; the cooperative control passed.
- **0:** both cases completed cleanup; the problem was not reproduced.
- **2:** setup, a turn, or the control failed; inspect the process logs.

The printed temporary directory retains each case's `receipts.txt`, CLI/server stdout and stderr, and isolated configuration for inspection. No reproduction files are deleted automatically. The runner's 30-second watchdog is only a failure safeguard; it does not provide a successful shutdown path.

These observations are specific to the tested version and platform. The runner prints both so the same reproduction can be used to check other builds.
