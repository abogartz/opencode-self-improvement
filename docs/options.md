# Options and environment variables

Every knob, in one place. The README keeps the ones you are likely to set; this
file is the complete reference, including what an invalid value does.

## Plugin options

Set them in the object form of the plugin entry in `opencode.json(c)`:

```json
{
  "plugins": [{ "package": "opencode-self-improvement", "options": { "injectBudget": 1200, "frontierBudget": 3600 } }]
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `injectBudget` | `1200` | Character cap on the injected relevance block and each contextual pull; trimmed at whole-memory boundaries. Env fallback: `OPENCODE_MEMORY_INJECT_BUDGET`. |
| `frontierBudget` | `3 × injectBudget` | Character cap on the session-start open-threads block. A thread longer than the budget is not injected and is reported as omitted. Env fallback: `OPENCODE_MEMORY_FRONTIER_BUDGET`. |
| `contradictionSurface` | `true` | Experimental: compare guided constant claims with bounded source reads and render a class-specific CONFLICT verdict. Set `false` to skip code checks and retain plain guidance. See [docs/contradiction-authority.md](contradiction-authority.md). |
| `notifyBlocked` | `true` | Terminal (TUI) only: toast when a write gate blocks a write. Blocks are always in `memory_evidence` either way. |
| `autoCapture` | `false` | Master switch for auto-capture. Off by default, so a plain install makes no extra model call. |
| `captureModel` | — | `"provider/id"` model used for auto-capture. Required when `autoCapture` is on; missing or invalid disables capture with a startup warning. |
| `captureMax` | `3` | Maximum candidates proposed per capture pass. |
| `captureOnCompact` | `true` | When `autoCapture` is on, also mine the transcript at compaction, before the summarizer replaces it. Its 5-minute cooldown is separate from the turn-end one, so the two triggers' hit-rates stay measurable. Setting it while `autoCapture` is off does nothing and reports a startup warning. |
| `captureGuidedRules` | `false` | POC: deterministic guided-candidate pre-pass. The user's own lines decide which stated values or rules are guided (numbers, rates, currency, explicit rule assertions) and attach the verbatim quote; the capture model may phrase such a row but cannot clear the flag or the quote, and a guided quote the user never wrote is refused at the write boundary instead of silently stripped. Fires alongside the model pass only — no extra model calls. |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENCODE_MEMORY_DIR` | Store location (default `~/.config/opencode/memory`). |
| `OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS` | Operator-only. When truthy, `memory_export`/`memory_import` accept paths anywhere on disk instead of confining themselves to the store. Off by default. It is read from the plugin process's own environment, so a model cannot grant it to itself through a tool argument. See [docs/import-quarantine.md](import-quarantine.md). |
| `OPENCODE_MEMORY_INJECT_BUDGET` | Fallback for `injectBudget`. |
| `OPENCODE_MEMORY_FRONTIER_BUDGET` | Fallback for `frontierBudget`. |
| `OPENCODE_COMMANDS_DIR` | Where the plugin mirrors its slash commands (default `~/.config/opencode/commands`). |
| `OPENCODE_VIEWER_HOST` | Interface the editor binds to (default `127.0.0.1`). A non-loopback bind serves the store over plain HTTP with no authentication — only do it on a network you control. |
| `OPENCODE_VIEWER_PORT` | Admin editor port (default `8787`). |
| `OPENCODE_VIEWER_ALLOWED_HOSTS` | Comma-separated hosts beyond loopback. |

`OPENCODE_MEMORY_DEDUP`, `OPENCODE_MEMORY_SYMPTOM` and `OPENCODE_MEMORY_QUERY_GATE` are documented separately in [docs/flags.md](flags.md): they switch behaviour that a measurement decided, so the evidence behind each one matters more than the default.
