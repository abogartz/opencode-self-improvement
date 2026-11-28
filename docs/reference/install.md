# Install variants and the version floor

The README leads with `opencode plugin add`, then a restart, then an optional
`/repo-init`. This file holds the other ways to install, how updates are
resolved, and what to point at when you are working on the plugin itself.

For the experimental oh-my-pi tools/context adapter, use the separate
[oh-my-pi installation guide](oh-my-pi.md).

## Plugin commands

```sh
opencode plugin add opencode-self-improvement
opencode plugin update opencode-self-improvement
```

Needs Bun 1.3.0 or newer in the opencode build (the tested floor); older Bun
reports a startup warning.

## How an unpinned entry resolves

An unpinned entry resolves `@latest` exactly once and is never re-resolved
afterwards, so updates are deliberate: run `opencode plugin update` when you want
one. To pin, append `@<version>` — see [npm](https://www.npmjs.com/package/opencode-self-improvement)
for what is current.

## Running from a checkout

To work on the plugin instead, clone it and point the entry at the checkout:

```sh
git clone https://github.com/abogartz/opencode-self-improvement.git
cd opencode-self-improvement && bun install
```

```json
{ "plugins": ["/full/path/to/opencode-self-improvement/index.ts"] }
```

Then `git pull` and restart opencode to update.

## Dropping it into the plugins directory

Loose discovery reads `<config>/plugins/<name>/index.ts` and a sibling `tui.ts`,
and the repository root carries both shims for exactly that route. Discovery
copies nothing and installs nothing, so the directory needs its own dependencies:

```sh
cd "<config>/plugins/opencode-self-improvement" && bun install
```

Without them the plugin fails to load, and the host reports it as `Plugin must
export a default definition with an id and an effect or setup function` — the
missing `zod` is the cause, not the export
([#464](https://github.com/abogartz/opencode-self-improvement/issues/464)). To see
which package could not be resolved, run the plugin once from a terminal inside the
affected project:

```sh
opencode run --standalone --print-logs "diagnostic"
```

`run` needs a message: without one it stops with `You must provide a message`
before loading any plugin. The desktop plugin panel lists the plugin and says
nothing about the dependency. The package route above avoids the step entirely.

## Restart rules by host

A config edit needs a restart to take effect. On the desktop app, relaunching the
app is not enough: the background service stays alive with the options it already
parsed, so use `opencode service restart`. That is also why `memory_evidence` can
report a `capture=` value your config no longer contains. See
[docs/reference/troubleshooting.md](troubleshooting.md).
