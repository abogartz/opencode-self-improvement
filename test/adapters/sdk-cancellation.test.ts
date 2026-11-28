import { expect, test } from "bun:test";
import { Effect } from "effect";
import { fromPromise } from "@opencode/plugin/promise/adapter";

test("pinned OpenCode Promise SDK drops generate.text request cancellation", async () => {
  const controller = new AbortController();
  const answer = Promise.withResolvers<{ text: string }>();
  const entered = Promise.withResolvers<void>();
  // Unused domains are inert; generation still crosses the real SDK adapter.
  const inert: any = new Proxy(() => Effect.void, { get: () => inert });
  const host = new Proxy(inert, {
    get: (_, key) =>
      key === "generate"
        ? {
            text: () =>
              Effect.promise(() => {
                entered.resolve();
                return answer.promise;
              }),
          }
        : inert,
  });
  const plugin = fromPromise({
    id: "cancellation-probe",
    async setup(ctx) {
      const pending = ctx.generate.text(
        { model: { providerID: "fake", id: "model" }, prompt: "probe" },
        { signal: controller.signal },
      );
      await entered.promise;
      controller.abort(new Error("cancelled"));
      answer.resolve({ text: "late answer" });
      expect(await pending).toEqual({ text: "late answer" });
    },
  });
  await Effect.runPromise(Effect.scoped(plugin.effect(host)));
});
