import { expect, test } from "bun:test";
import { createOpenCodeLifecycle } from "../../src/adapters/opencode/lifecycle.ts";
import type { LifecycleHandlers } from "../../src/host/lifecycle.ts";
import type { PluginCtx } from "../../src/adapters/opencode/context.ts";

function fixture() {
  const hooks = new Map<string, (event: any) => Promise<void> | void>();
  const disposed: string[] = [];
  const ctx: PluginCtx = {
    tool: {
      async transform() {},
      async hook(name, cb) {
        hooks.set(name, cb);
        return {
          dispose() {
            disposed.push(name);
          },
        };
      },
    },
    session: {
      async hook(name, cb) {
        hooks.set(name, cb);
        return {
          dispose() {
            disposed.push(name);
          },
        };
      },
    },
  };
  return { ctx, hooks, disposed };
}

function handlers(
  overrides: Partial<LifecycleHandlers> = {},
): LifecycleHandlers {
  return {
    async beforeTool() {},
    async afterTool() {},
    async context() {},
    async prompt() {},
    async compact() {},
    identity() {},
    async usage() {},
    error(error) {
      throw error;
    },
    ...overrides,
  };
}

test("context is normalized before awaits and append targets its own system parts", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  const seen: string[] = [];
  const registration = await createOpenCodeLifecycle(f.ctx).register(
    handlers({
      async context(event) {
        await gate.promise;
        seen.push(event.sessionID!);
        event.appendSystem?.(`memory for ${event.sessionID}`);
        expect(event.observedResults).toEqual([
          { callID: "c", tool: "read", text: "visible" },
        ]);
      },
    }),
  );
  const system: unknown[] = [];
  const raw = {
    sessionID: "a",
    system,
    messages: [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "c",
            name: "read",
            result: { type: "text", value: "visible" },
          },
        ],
      },
    ],
  };
  const pending = f.hooks.get("context")!(raw);
  raw.sessionID = "b";
  raw.system = [];
  gate.resolve();
  await pending;
  expect(seen).toEqual(["a"]);
  expect(system).toEqual([{ type: "text", text: "memory for a" }]);
  expect(raw.system).toEqual([]);
  await registration.dispose();
});

test("missing APIs register safely and missing delivery surfaces stay explicit", async () => {
  await (await createOpenCodeLifecycle({}).register(handlers())).dispose();
  const f = fixture();
  const registration = await createOpenCodeLifecycle(f.ctx).register(
    handlers({
      async context(event) {
        expect(event.appendSystem).toBeUndefined();
      },
      async afterTool(event) {
        expect(event.appendResult("tail")).toBe(false);
      },
    }),
  );
  await f.hooks.get("context")!({ sessionID: "s" });
  await f.hooks.get("execute.after")!({ sessionID: "s", result: "plain" });
  await registration.dispose();
});

test("cleanup stops late hooks, is idempotent, and attempts every disposer", async () => {
  const f = fixture();
  let prompts = 0;
  const registration = await createOpenCodeLifecycle(f.ctx).register(
    handlers({
      async prompt() {
        prompts++;
      },
    }),
  );
  await f.hooks.get("prompt")!({ sessionID: "s", prompt: { text: "hello" } });
  const cleanup = registration.dispose();
  await f.hooks.get("prompt")!({ sessionID: "s", prompt: { text: "late" } });
  await cleanup;
  await registration.dispose();
  expect(prompts).toBe(1);
  expect(f.disposed).toEqual([
    "compaction",
    "prompt",
    "context",
    "execute.after",
    "execute.before",
  ]);
});

test("an already-started context handler retains its delivery surface during cleanup", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  const registration = await createOpenCodeLifecycle(f.ctx).register(
    handlers({
      async context(event) {
        await gate.promise;
        event.appendSystem?.("delivered");
      },
    }),
  );
  const system: unknown[] = [];
  const pending = f.hooks.get("context")!({ sessionID: "s", system });
  await registration.dispose();
  gate.resolve();
  await pending;
  expect(system).toEqual([{ type: "text", text: "delivered" }]);
});

test("failed registration rolls back prior hooks, even when a disposer rejects", async () => {
  const f = fixture();
  const errors: unknown[] = [];
  const registrationError = new Error("registration failed");
  const disposalError = new Error("disposal failed");
  f.ctx.session!.hook = async () => {
    throw registrationError;
  };
  f.ctx.tool!.hook = async (name, cb) => {
    f.hooks.set(name, cb);
    return {
      dispose() {
        f.disposed.push(name);
        if (name === "execute.after") throw disposalError;
      },
    };
  };
  let called = false;
  await expect(
    createOpenCodeLifecycle(f.ctx).register(
      handlers({
        async beforeTool() {
          called = true;
        },
        error: (error) => {
          errors.push(error);
        },
      }),
    ),
  ).rejects.toBe(registrationError);
  await f.hooks.get("execute.before")!({});
  expect(called).toBe(false);
  expect(f.disposed).toEqual(["execute.after", "execute.before"]);
  expect(errors).toEqual([disposalError]);
});

test("queued observations after disposal are ignored and the subscription receives cancellation", async () => {
  const next = Promise.withResolvers<IteratorResult<unknown>>();
  const closed = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  let called = false;
  const registration = await createOpenCodeLifecycle({
    event: {
      subscribe(options) {
        signal = options?.signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => next.promise,
              async return() {
                closed.resolve();
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    },
  }).register(
    handlers({
      identity() {
        called = true;
      },
    }),
  );
  await registration.dispose();
  expect(signal?.aborted).toBe(true);
  next.resolve({
    done: false,
    value: {
      type: "session.created",
      data: { sessionID: "late", location: { directory: "/wrong" } },
    },
  });
  await closed.promise;
  expect(called).toBe(false);
});

test("hooks register before observations and usage handlers retain stream order", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const seen: string[] = [];
  f.ctx.event = {
    async *subscribe() {
      expect([...f.hooks.keys()]).toEqual([
        "execute.before",
        "execute.after",
        "context",
        "prompt",
        "compaction",
      ]);
      yield {
        type: "session.moved",
        data: { sessionID: "s", location: { directory: "/new" } },
      };
      yield {
        type: "session.usage.updated",
        data: { sessionID: "s", tokens: { input: 2 } },
      };
      yield {
        type: "session.usage.updated",
        data: { sessionID: "s", tokens: { input: 3 } },
      };
    },
  };
  const registration = await createOpenCodeLifecycle(f.ctx).register(
    handlers({
      identity(event) {
        seen.push(`identity:${event.directory}`);
      },
      async usage(event) {
        seen.push(`usage:${event.input}`);
        expect(event.cumulative).toBe(true);
        if (event.input === 2) {
          entered.resolve();
          await release.promise;
        } else finished.resolve();
      },
    }),
  );
  try {
    await entered.promise;
    expect(seen).toEqual(["identity:/new", "usage:2"]);
  } finally {
    release.resolve();
  }
  await finished.promise;
  expect(seen).toEqual(["identity:/new", "usage:2", "usage:3"]);
  await registration.dispose();
});

test("compaction snapshots normalized public transcript before asynchronous handlers", async () => {
  const f = fixture();
  const resumed = Promise.withResolvers<void>();
  const raw = {
    sessionID: "s",
    messages: [
      { type: "user", text: "remember this" },
      { type: "assistant", content: [{ type: "reasoning", text: "private" }] },
    ],
  };
  const registration = await createOpenCodeLifecycle(f.ctx).register(
    handlers({
      async compact(event) {
        await resumed.promise;
        expect(event.transcript).toEqual([
          { role: "user", text: "remember this" },
          { role: "assistant", text: "" },
        ]);
      },
    }),
  );
  try {
    const pending = f.hooks.get("compaction")!(raw);
    raw.messages[0]!.text = "changed while waiting";
    resumed.resolve();
    await pending;
  } finally {
    await registration.dispose();
  }
});
