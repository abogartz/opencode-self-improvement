import { expect, test } from "bun:test";
import {
  captureEvidenceContext,
  record,
  recordSync,
} from "../../src/telemetry/record.ts";
import { currentHarness, withHarness } from "../../src/telemetry/harness.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";
import { withTempStore } from "../helpers/temp-store.ts";

withTempStore({ prefix: "osi-harness-context-" });

test("async source attribution and captured contexts survive interleaved harness work", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = withHarness("opencode", async () => {
    entered.resolve();
    await release.promise;
    await record("first", { harness: "spoofed" }, false);
    return captureEvidenceContext();
  });
  await entered.promise;
  try {
    await withHarness("oh-my-pi", async () => {
      await record("second", {}, false);
    });
  } finally {
    release.resolve();
  }
  const captured = await first;
  withHarness("oh-my-pi", () =>
    recordSync("deferred", {}, false, undefined, captured),
  );
  await record("unbound", {}, false);
  const rows = readEvidenceLog();
  expect(rows.find((r) => r.ev === "first")?.harness).toBe("opencode");
  expect(rows.find((r) => r.ev === "second")?.harness).toBe("oh-my-pi");
  expect(rows.find((r) => r.ev === "deferred")?.harness).toBe("opencode");
  expect(rows.find((r) => r.ev === "unbound")?.harness).toBe("unknown");
  expect(currentHarness()).toBe("unknown");
});
