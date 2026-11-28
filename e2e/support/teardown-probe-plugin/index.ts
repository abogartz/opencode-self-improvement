import { appendFileSync } from "node:fs";

export const DELAYS_MS = [0, 10, 50, 200] as const;

interface ProbeContext {
  event: {
    subscribe(options: {
      signal: AbortSignal;
    }): AsyncIterable<{ type: string }>;
  };
}

export default {
  id: "probe-teardown",
  setup(ctx: ProbeContext) {
    const out = process.env.TEARDOWN_PROBE_OUT;
    if (!out) return;
    const record = (receipt: string) => appendFileSync(out, `${receipt}\n`);
    const controller = new AbortController();
    const events = ctx.event.subscribe({ signal: controller.signal });
    record("subscribed");
    process.once("beforeExit", () => record("beforeExit"));
    process.once("exit", () => record("exit"));

    void (async () => {
      try {
        for await (const event of events) {
          if (event.type !== "session.execution.succeeded") continue;
          record("arrived");
          await Promise.resolve();
          record("microtask");
          // Start the timers together so each measures from the same arrival.
          await Promise.all(
            DELAYS_MS.map(async (ms) => {
              await new Promise<void>((resolve) => setTimeout(resolve, ms));
              record(`timer:${ms}`);
            }),
          );
          break;
        }
      } catch (error) {
        if (!controller.signal.aborted) record(`error:${String(error)}`);
      }
    })();
    return async () => {
      record("cleanup-start");
      controller.abort();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      record("cleanup-end");
    };
  },
};
