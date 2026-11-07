// Shared test harness for the OpenCode V2 plugin. Loads the plugin by running
// its `setup(ctx)` against a fake V2 context that captures registered tools,
// tools/hooks and commands. Also exposes a V1-shaped `hooks` adapter so tests
// written against the old `await SelfImprovement(ctx)` contract keep working
// while exercising the real V2 registrations (including the fail-closed guards).
//
// Fakes (all inert by default, backward compatible):
//   - `options`: passed through to the plugin (autoCapture etc.)
//   - `capture.events`: a BROADCAST push-queue backing event.subscribe (each
//     subscriber gets every pushed event; the plugin runs a measured-usage
//     listener by default plus auto-capture when enabled).
//     The test calls push(event) to feed the plugin's `for await` loops; they
//     park between events and wake on push, on abort, or on close().
//   - `capture.generate`: canned generate.text reply + call log.
//   - `capture.context`: canned session.context messages + call log.
//   - `cleanup`: whatever setup() returned (no-op when it returned nothing).
import plugin from "../index.ts";
import { afterEach, beforeEach } from "bun:test";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { resetState } from "../src/core/state.ts";

/**
 * Register an isolated store for each test in the current describe scope.
 * Read paths inside hooks/tests (`const store = withTempStore({ prefix: "osi-example-" })`);
 * do not destructure them at suite declaration time. Register this before local
 * setup. Put asynchronous resource cleanup in a nested describe so it completes
 * before the fixture's outer teardown removes the store.
 *
 * Both memory and command output are confined to the fixture. Prior environment
 * values (including absent ones) are restored even if cleanup refuses or fails.
 */
export function withTempStore({
  prefix = "osi-test-",
}: {
  prefix?: string;
} = {}): {
  readonly root: string;
  readonly memoryDir: string;
} {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(prefix)) {
    throw new Error(
      "withTempStore prefix must be a nonempty filename prefix without path separators",
    );
  }
  let active:
    | {
        root: string;
        memoryDir: string;
        tempParent: string;
        memory?: string;
        commands?: string;
      }
    | undefined;

  function assertRoot(root: string, tempParent: string): void {
    const canonical = realpathSync(root);
    const below = relative(tempParent, canonical);
    if (
      !below ||
      below === ".." ||
      below.startsWith(`..${sep}`) ||
      isAbsolute(below) ||
      lstatSync(root).isSymbolicLink() ||
      canonical !== root
    ) {
      throw new Error(
        "withTempStore: refusing cleanup of a root outside its original temporary directory",
      );
    }
  }

  beforeEach(() => {
    const tempParent = realpathSync(tmpdir());
    const root = mkdtempSync(join(tempParent, prefix));
    assertRoot(root, tempParent);
    active = {
      root,
      memoryDir: join(root, "memory"),
      tempParent,
      memory: process.env.OPENCODE_MEMORY_DIR,
      commands: process.env.OPENCODE_COMMANDS_DIR,
    };
    process.env.OPENCODE_MEMORY_DIR = active.memoryDir;
    process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
    resetState();
  });
  afterEach(() => {
    const state = active;
    if (!state) return;
    try {
      try {
        lstatSync(state.root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      // Re-check the owned root, never a test-modified environment variable.
      assertRoot(state.root, state.tempParent);
      rmSync(state.root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    } finally {
      if (state.memory === undefined) delete process.env.OPENCODE_MEMORY_DIR;
      else process.env.OPENCODE_MEMORY_DIR = state.memory;
      if (state.commands === undefined)
        delete process.env.OPENCODE_COMMANDS_DIR;
      else process.env.OPENCODE_COMMANDS_DIR = state.commands;
      resetState();
      active = undefined;
    }
  });
  function current() {
    if (!active)
      throw new Error("withTempStore paths are available only during a test");
    return active;
  }
  return {
    get root() {
      return current().root;
    },
    get memoryDir() {
      return current().memoryDir;
    },
  };
}

type ToolRecord = {
  name: string;
  description: string;
  input: unknown;
  execute: (args: any, ctx?: any) => Promise<{ content: string }>;
};

export interface CaptureFakes {
  events: {
    subscribeCalls: number;
    signals: AbortSignal[];
    push: (event: unknown) => void;
    close: () => void;
  };
  generate: {
    calls: Array<{ prompt: string; model: unknown }>;
    response: string;
    // Deterministic stall seam (#116): when set, the stub awaits this promise
    // AFTER logging the call, so a test can park the plugin mid-model-call and
    // interleave other work before releasing it — no sleep-based races.
    park?: Promise<unknown>;
    // Failure seam: when set, the stub throws this instead of replying, so a
    // test can drive the plugin's capture-failure path.
    throws?: Error;
  };
  context: {
    calls: string[];
    messages: unknown;
  };
  session: {
    getCalls: string[];
    row: unknown;
  };
  // #139: what the fake ctx.model.default.get() returns (undefined = the host
  // exposes no default model). Tests set this to drive the last-resort
  // inheritance path of an omitted captureModel.
  modelDefault?: { providerID: string; modelID: string };
}

export interface LoadedPlugin {
  tools: Record<string, ToolRecord>;
  toolHooks: Record<string, (event: any) => Promise<void>>;
  sessionHooks: Record<string, (event: any) => Promise<void>>;
  commands: Record<
    string,
    { name: string; execute: (input: any) => Promise<void> }
  >;
  capture: CaptureFakes;
  cleanup: () => void | Promise<void>;
  // V1-shaped adapter (delegates to the real V2 registrations)
  tool: Record<string, { execute: (args: any) => Promise<string> }>;
  "tool.execute.before": (input: any) => Promise<void>;
  "tool.execute.after": (input: any, output: any) => Promise<void>;
  "experimental.chat.system.transform": (
    input: any,
    output: any,
  ) => Promise<void>;
  "experimental.session.compacting": (input: any, output: any) => Promise<void>;
}

export async function loadPlugin(
  directory: string | null = process.cwd(),
  options?: Record<string, unknown>,
): Promise<LoadedPlugin> {
  const tools: Record<string, ToolRecord> = {};
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
  const commands: Record<
    string,
    { name: string; execute: (input: any) => Promise<void> }
  > = {};

  // --- Fakes -----------------------------------------------------------------
  // Broadcast event bus: every subscribe() registers its own parked consumer,
  // and push()/close() wake ALL of them (the plugin now runs two listeners:
  // the measured-usage one and, when enabled, auto-capture). Each subscriber
  // gets its own queue so events are not raced between consumers.
  type Subscriber = { q: unknown[]; wake: (() => void) | null };
  const subs: Subscriber[] = [];
  let queueClosed = false;
  const capture: CaptureFakes = {
    events: {
      subscribeCalls: 0,
      signals: [],
      push: (event) => {
        for (const s of subs) s.q.push(event);
        for (const s of subs) s.wake?.();
      },
      close: () => {
        queueClosed = true;
        for (const s of subs) s.wake?.();
      },
    },
    generate: { calls: [], response: "" },
    context: { calls: [], messages: [] },
    session: { getCalls: [], row: undefined },
  };

  const ctx = {
    // null directory simulates a server-start setup with no session location
    // attached yet.
    ...(directory ? { location: { directory } } : {}),
    options: options ?? {},
    tool: {
      transform: async (
        cb: (editor: { add: (t: ToolRecord) => void }) => void,
      ) =>
        cb({
          add: (t) => {
            tools[t.name] = t;
          },
        }),
      hook: async (n: string, cb: (event: any) => Promise<void>) => {
        toolHooks[n] = cb;
      },
    },
    command: {
      transform: async (cb: (editor: { add: (c: any) => void }) => void) =>
        cb({
          add: (c) => {
            commands[c.name] = c;
          },
        }),
    },
    session: {
      hook: async (n: string, cb: (event: any) => Promise<void>) => {
        sessionHooks[n] = cb;
      },
      prompt: async (input: any) => ({ ok: true, input }),
      context: async (input: any) => {
        capture.context.calls.push(String(input?.sessionID ?? ""));
        return capture.context.messages;
      },
      get: async (input: any) => {
        capture.session.getCalls.push(String(input?.sessionID ?? ""));
        return capture.session.row;
      },
    },
    event: {
      subscribe: (o?: { signal?: AbortSignal }) => {
        capture.events.subscribeCalls++;
        if (o?.signal) capture.events.signals.push(o.signal);
        const sub: Subscriber = { q: [], wake: null };
        subs.push(sub);
        // Per-subscriber async GENERATOR (an object-literal
        // [Symbol.asyncIterator] async method is dropped by Bun 1.4.3's
        // transpiler, hence generators).
        return (async function* () {
          for (;;) {
            if (sub.q.length) yield sub.q.shift();
            else if (queueClosed || o?.signal?.aborted) return;
            else {
              await new Promise<void>((resolve) => {
                const done = () => {
                  sub.wake = null;
                  o?.signal?.removeEventListener("abort", done);
                  resolve();
                };
                sub.wake = done;
                o?.signal?.addEventListener("abort", done, { once: true });
              });
            }
          }
        })();
      },
    },
    generate: {
      text: async (input: any) => {
        capture.generate.calls.push({
          prompt: String(input?.prompt ?? ""),
          model: input?.model,
        });
        if (capture.generate.park) await capture.generate.park;
        if (capture.generate.throws) throw capture.generate.throws;
        return { text: capture.generate.response };
      },
    },
    // #139: host default model domain; get() returns whatever the test set.
    model: {
      default: {
        get: () => capture.modelDefault,
      },
    },
  };

  const cleanup = await plugin.setup(ctx as never);

  const tool: LoadedPlugin["tool"] = {};
  for (const [name, t] of Object.entries(tools)) {
    tool[name] = {
      execute: async (args: any) => (await t.execute(args, {})).content,
    };
  }

  return {
    tools,
    toolHooks,
    sessionHooks,
    commands,
    capture,
    cleanup:
      typeof cleanup === "function"
        ? (cleanup as () => void | Promise<void>)
        : () => {},
    tool,
    "tool.execute.before": async (input: any) => {
      await toolHooks["execute.before"]?.({
        sessionID: input?.sessionID,
        callID: input?.callID,
        tool: input?.tool,
      });
    },
    "tool.execute.after": async (input: any, output: any) => {
      await toolHooks["execute.after"]?.({
        sessionID: input?.sessionID,
        callID: input?.callID,
        tool: input?.tool,
        input: input?.args,
        result: { content: output?.output, metadata: output?.metadata },
      });
    },
    // Drive the real session.context hook (guarded), mapping its text parts
    // back onto the V1 `output.system: string[]` shape. `model` (the V2
    // SessionRequest ref) rides along so #139 model inheritance can be
    // replayed with the ref a real host delivers.
    "experimental.chat.system.transform": async (input: any, output: any) => {
      const parts: Array<{ type: string; text: string }> = [];
      await sessionHooks["context"]?.({
        sessionID: input?.sessionID,
        system: parts,
        model: input?.model,
      });
      if (Array.isArray(output?.system))
        for (const p of parts) output.system.push(p.text);
    },
    // Drive the real session.compaction hook (guarded), mirroring the context
    // adapter: the hook sees a `system` parts array and pushed part texts are
    // copied back onto `output.system` when the caller provided one. `messages`
    // (the V2 SessionCompaction payload the real host carries) passes through
    // so compaction-triggered auto-capture can be replayed with a
    // pre-compaction transcript.
    "experimental.session.compacting": async (input: any, output: any) => {
      const parts: Array<{ type: string; text: string }> = [];
      await sessionHooks["compaction"]?.({
        sessionID: input?.sessionID,
        system: parts,
        messages: input?.messages,
      });
      if (Array.isArray(output?.system))
        for (const p of parts) output.system.push(p.text);
    },
  };
}
