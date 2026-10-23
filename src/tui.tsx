// Terminal surface for opencode-self-improvement (the CLI/TUI half of the
// plugin). Runs in the terminal process, beside the host's OpenTUI renderer:
// a one-line footer badge (what is in my context + is the cache healthy), a
// /memory session panel, and toasts when a write gets blocked. All data comes
// from the per-session status hand-off the server plugin writes (src/status.ts)
// plus the evidence log — plain file reads, no model, no network. The badge
// reads ONLY its own session's file: a missing file renders "mem -" rather
// than another session's epoch. Against a REMOTE server the panel reports that
// status is local-only (the RPC surface is the follow-up).
import { watch, type FSWatcher } from "node:fs";
import { For, Show, createSignal } from "solid-js";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import { memoryRoot, evidenceDir } from "./config.ts";
import {
  blockedRecent,
  cacheHealth,
  cacheRate,
  cacheLines,
  contextLines,
  readStatus,
  statusDir,
  type BlockedRow,
  type CacheHealth,
  type StatusPayload,
} from "./status.ts";

const PANEL = "self-improvement.memory";
const POLL_MS = 5000;

function age(iso?: string): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function Section(props: { t: string }) {
  const context = usePlugin();
  return <text fg={context.theme.text.base}>{"\n▍ " + props.t}</text>;
}

export default Plugin.define({
  id: "self-improvement.tui",
  setup(context) {
    const notifyBlocked = context.options?.notifyBlocked !== false;
    const [status, setStatus] = createSignal<StatusPayload | null>(null);
    const [blocked, setBlocked] = createSignal<BlockedRow[]>([]);
    let seenBlockKeys: Set<string> | null = null; // null until first poll (no startup toast storm)
    // The session whose status file we render. Fed by slot inputs (the
    // prompt.footer receives the active session; the panel its own).
    let activeSid: string | undefined;

    // Dot colors: theme semantic colors when the host provides them, stable
    // hex fallbacks otherwise. Resolved once per setup.
    const th = context.theme as unknown as Record<string, any>;
    const col = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
    const DOT: Record<CacheHealth, string> = {
      green: col(th.success, "#4ade80"),
      recent: col(th.warning, "#fbbf24"),
      amber: col(th.warning, "#fbbf24"),
      red: col(th.error, col(th.danger, "#f87171")),
      unknown: col(th.text?.muted, col(th.text?.base, "#9ca3af")),
    };

    // Inline color inside <text> must be a <span> (a nested <text> crashes:
    // add() only accepts strings / TextNodeRenderable / StyledText), and the
    // reconciler's setProperty only honors `style` on text nodes — a direct
    // fg attribute is silently dropped. SpanProps types style as {} (upstream
    // gap), so pass a pre-typed object: assignment skips the excess-prop
    // check, and runtime reads style.fg/style.bg.
    const spanStyle = (fg: string): { fg?: string } => ({ fg });

    const refresh = async (sid?: string): Promise<void> => {
      if (sid !== undefined) activeSid = sid;
      setStatus(await readStatus(activeSid));
      const rows = await blockedRecent(8);
      setBlocked(rows);
      const keys = new Set(rows.map((r) => `${r.ts}|${r.reason}`));
      if (notifyBlocked && seenBlockKeys) {
        for (const r of rows) {
          if (seenBlockKeys.has(`${r.ts}|${r.reason}`)) continue;
          context.ui.toast.show({
            title: "memory blocked",
            message: `${r.reason} — run /memory for the reason list`,
            variant: "warning",
            duration: 6000,
            sessionID: r.sid,
          });
        }
      }
      seenBlockKeys = keys;
    };
    void refresh();

    // ---- live updates ---------------------------------------------------------
    // The server rewrites the status files the moment an epoch recomputes or a
    // measured turn lands; polling made the badge lag up to POLL_MS behind its
    // own data. Directories watched (TUI and server share this machine by
    // design; against a remote server there are no files and the badge shows
    // "mem -" regardless). The poll survives as a fallback: it refreshes the
    // age display, reattaches watchers after failures, and attaches the
    // status/ watcher once the server's FIRST write creates the directory.
    // Debounced because Bun.write can surface as several fs events per write
    // and prune touches the directory too.
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => void refresh(), 150);
    };
    let rootWatcher: FSWatcher | null = null;
    let dirWatcher: FSWatcher | null = null;
    let evWatcher: FSWatcher | null = null;
    const attach = (make: () => FSWatcher): FSWatcher | null => {
      try {
        const w = make();
        w.on("error", () => {
          try {
            w.close();
          } catch {}
          if (rootWatcher === w) rootWatcher = null;
          if (dirWatcher === w) dirWatcher = null;
          if (evWatcher === w) evWatcher = null;
        });
        return w;
      } catch {
        return null; // path missing (fresh install) — the poll retries
      }
    };
    const ensureWatchers = () => {
      if (!rootWatcher) rootWatcher = attach(() => watch(memoryRoot(), scheduleRefresh));
      if (!dirWatcher) dirWatcher = attach(() => watch(statusDir(), scheduleRefresh));
      if (!evWatcher) evWatcher = attach(() => watch(evidenceDir(), scheduleRefresh));
    };
    ensureWatchers();
    const timer = setInterval(() => {
      ensureWatchers();
      void refresh();
    }, POLL_MS);

    // ---- badge: budget use + cache health; home footer keeps store size ----
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        // Session switches re-render this slot: adopt the new sid and poll
        // once immediately so the badge does not wait up to POLL_MS.
        if (input.sessionID !== undefined && input.sessionID !== activeSid) {
          activeSid = input.sessionID;
          void refresh();
        }
        const s = status();
        if (!s) return <text fg={context.theme.text.base}>mem -</text>;
        const rate = cacheRate(s.measured);
        return (
          <text fg={context.theme.text.base}>
            <span style={spanStyle(DOT[cacheHealth(s)])}>●</span>
            {` mem ${s.blockChars}/${s.budget}c · cache ${rate ? `${rate.pct}%` : "—"}`}
          </text>
        );
      },
    });
    context.ui.slot({
      append: "home.footer.status",
      render: () => {
        const s = status();
        return <text fg={context.theme.text.base}>{s ? `mem ${s.store.active}` : "mem -"}</text>;
      },
    });

    // ---- /memory panel --------------------------------------------------------
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <MemoryPanel panel={panel} refresh={refresh} status={status()} blocked={blocked()} />
        </Show>
      ),
    });

    // Command + slash registration on a persistent invisible slot so it exists
    // while the panel is closed (docs pattern).
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "self-improvement.memory",
              title: "Memory status panel",
              group: "Memory",
              palette: true,
              slash: { name: "memory" },
              run: () => {
                if (!context.ui.panel.open(PANEL)) {
                  context.ui.toast.show({ message: "the memory panel needs an open session", variant: "info" });
                }
              },
            },
          ],
        }));
        return null;
      },
    });

    return () => {
      clearInterval(timer);
      if (pendingTimer) clearTimeout(pendingTimer);
      for (const w of [rootWatcher, dirWatcher, evWatcher]) {
        try {
          w?.close();
        } catch {}
      }
    };
  },
});

function MemoryPanel(props: {
  panel: PanelInput;
  refresh: (sid?: string) => Promise<void>;
  status: StatusPayload | null;
  blocked: BlockedRow[];
}) {
  const context = usePlugin();
  context.keymap.layer(() => ({
    commands: [
      {
        id: "self-improvement.memory.refresh",
        title: "Refresh",
        bind: "r",
        run: () => void props.refresh(props.panel.sessionID),
      },
      { id: "self-improvement.memory.fullscreen", title: "Fullscreen", bind: "f", run: props.panel.toggleFullscreen },
    ],
  }));

  const s = () => props.status;
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={context.theme.text.base}>
        MEMORY — as of {s() ? age(s()!.at) : "never"}
        {s() ? ` · ${s()!.sessionID}` : ""}
      </text>

      <Section t="CONTEXT" />
      <Show
        when={s()}
        fallback={<text fg={context.theme.text.base}>  no epoch yet — nothing injected (fresh server, or no prompt scored)</text>}
      >
        <For each={contextLines(s()!)}>{(line) => <text fg={context.theme.text.base}>{line}</text>}</For>
      </Show>

      <Section t="CACHE" />
      <Show when={s()} fallback={<text fg={context.theme.text.base}>  nothing to report before the first epoch</text>}>
        <For each={cacheLines(s()!)}>{(line) => <text fg={context.theme.text.base}>{line}</text>}</For>
      </Show>

      <Section t="INJECTED BLOCK (VERBATIM)" />
      <Show when={s()}>
        <Show
          when={s()!.block}
          fallback={
            <text fg={context.theme.text.base}>
              {"  abstained — your prompt shares no content vocabulary with any memory, so nothing was injected (by design)"}
            </text>
          }
        >
          <For each={s()!.block.split("\n")}>{(line) => <text fg={context.theme.text.base}>{"  " + line}</text>}</For>
        </Show>
      </Show>

      <Section t="RECENT BLOCKED WRITES" />
      <Show when={props.blocked.length} fallback={<text fg={context.theme.text.base}>  (none today or yesterday)</text>}>
        <For each={props.blocked}>
          {(b) => <text fg={context.theme.text.base}>{"  " + b.ts.slice(11, 19) + "  " + b.reason + "  " + b.sid}</text>}
        </For>
      </Show>

      <Section t="STORE" />
      <Show when={s()}>
        <text fg={context.theme.text.base}>
          {"  " + (s()?.store.active ?? 0) + " active · " + (s()?.store.superseded ?? 0) + " superseded · " +
            (s()?.store.open ?? 0) + " open · " + (s()?.store.scopes ?? 0) + " scopes" +
            ((s()?.store.malformed ?? 0) > 0 ? " · " + s()!.store.malformed + " malformed (skipped)" : "")}
        </text>
      </Show>

      <text fg={context.theme.text.base}>{"\n  r refresh · f fullscreen · esc close"}</text>
    </box>
  );
}
