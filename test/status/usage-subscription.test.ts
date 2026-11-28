import { createOpenCodeLifecycle } from "../../src/adapters/opencode/lifecycle.ts";
import { expect, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { guarded } from "../../src/core/hooks.ts";
import { registerHooks } from "../../src/runtime/events.ts";
import { createInjectionEpochs } from "../../src/inject/epochs.ts";
import { PULL_SHIPPED } from "../../src/inject/pull.ts";
import type { Measured } from "../../src/status/payload.ts";

const WARNING =
  "[opencode-self-improvement] lifecycle subscription or cleanup failed (ignored):";

async function rejectedSubscription(abort: boolean) {
  const pull = Promise.withResolvers<IteratorResult<unknown>>();
  const measuredTurns = new Map<string, Measured>();
  const noteHits = async () => {};
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const controller = await registerHooks(
      createOpenCodeLifecycle({
        event: {
          subscribe: () => ({
            [Symbol.asyncIterator]: () => ({ next: () => pull.promise }),
          }),
        },
      }),
      {
        guarded,
        sessions: createInjectionEpochs({
          budget: 0,
          frontierBudget: 0,
          measuredTurns,
          forgetUsage: () => {},
          noteHits,
        }),
        instanceDir: undefined,
        budget: 0,
        noteHits,
        bindSessionIdentity: async () => {},
        bindSessionFromApi: async () => {},
        measuredTurns,
        flushStatus: async () => {},
        pullScope: PULL_SHIPPED,
        getCompactCapture: () => undefined,
      },
    );
    if (abort) await controller.dispose();
    pull.reject(new Error("usage stream failed"));
    // The rejection and catch run before the next turn of the event loop.
    await setImmediate();
    return warn.mock.calls.filter(
      ([message]) => typeof message === "string" && message.startsWith(WARNING),
    );
  } finally {
    warn.mockRestore();
  }
}

test("an unexpected usage subscription rejection warns once", async () => {
  expect(await rejectedSubscription(false)).toEqual([
    [`${WARNING} usage stream failed`],
  ]);
});

test("a usage subscription rejection during teardown stays quiet", async () => {
  expect(await rejectedSubscription(true)).toEqual([]);
});
