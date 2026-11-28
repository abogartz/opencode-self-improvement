import { expect, test } from "bun:test";
import { formatLine } from "../../src/core/logfmt/format.ts";
import {
  summarizeHarnessActivity,
  harnessActivityLines,
} from "../../src/status/harness-stats.ts";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const line = (fields: Record<string, unknown>) =>
  formatLine({ ts: new Date(NOW - 1000).toISOString(), ...fields });
const usage = (harness: string, input: number, observed: number) =>
  line({
    ev: "session_usage",
    harness,
    session: "same-private-session",
    observed,
    input,
    read: 20,
    write: 5,
    output: 10,
    reasoning: 2,
  });

test("legacy activity belongs to OpenCode and explicit unknown remains separate", () => {
  const stats = summarizeHarnessActivity(
    [
      line({ ev: "plugin_load", capture: "on" }),
      line({ ev: "plugin_load", harness: "oh-my-pi", capture: "off" }),
      line({
        ev: "capture_cost",
        session: "same-session",
        prompt_chars: 40,
        text_chars: 8,
        est_tokens: 12,
      }),
      line({
        ev: "capture_cost",
        harness: "oh-my-pi",
        session: "same-session",
        prompt_chars: 80,
        text_chars: 8,
        est_tokens: 22,
      }),
      line({ ev: "capture_lag", lag: 10 }),
      line({ ev: "capture_lag", harness: "oh-my-pi", lag: 100 }),
      line({ ev: "write_blocked", harness: "unknown" }),
    ],
    [
      line({ ev: "memory_used", src: "recall", mem: "[old]" }),
      line({
        ev: "memory_used",
        harness: "oh-my-pi",
        src: "pull",
        mem: "[new]",
      }),
    ],
    30,
    NOW,
  );
  expect(stats.harnesses.map((g) => g.harness)).toEqual([
    "oh-my-pi",
    "opencode",
    "unknown",
  ]);
  expect(stats.total.retrievals).toEqual({ inject: 0, pull: 1, recall: 1 });
  expect(stats.total.capture.calls).toBe(2);
  expect(stats.total.capture.sessions).toBe(2);
  expect(stats.total.capture.estTokens).toBe(34);
  expect(stats.total.captureLag).toEqual({ p50: 10, p95: 100, n: 2 });
  expect(
    stats.harnesses.find((g) => g.harness === "opencode")?.captureHealth.state,
  ).toBe("on");
  expect(
    stats.harnesses.find((g) => g.harness === "oh-my-pi")?.captureHealth.state,
  ).toBe("off");
  expect(
    stats.harnesses.find((g) => g.harness === "unknown")?.blockedWrites,
  ).toBe(1);
  expect(stats.total.usage).toBeNull();
});

test("latest session totals replace duplicate and out-of-order receipts per harness", () => {
  const stats = summarizeHarnessActivity(
    [
      usage("opencode", 100, NOW - 10),
      usage("opencode", 100, NOW - 10),
      usage("opencode", 999, NOW - 100),
      usage("oh-my-pi", 200, NOW - 20),
      line({
        ev: "session_usage",
        harness: "opencode",
        session: "same-private-session",
        observed: NOW,
        input: -1,
        read: 0,
        write: 0,
        output: 0,
        reasoning: 0,
      }),
    ],
    [],
    30,
    NOW,
  );
  expect(stats.total.usage).toEqual({
    sessions: 2,
    input: 300,
    read: 40,
    write: 10,
    output: 20,
    reasoning: 4,
  });
  expect(
    stats.harnesses.find((g) => g.harness === "opencode")?.usage?.input,
  ).toBe(100);
  const rendered = harnessActivityLines(stats).join("\n");
  expect(rendered).not.toInclude("same-private-session");
  expect(rendered).toInclude("Legacy records without a harness are OpenCode");
});

test("missing, malformed, future and expired telemetry does not become reported zero usage", () => {
  const stats = summarizeHarnessActivity(
    [
      line({ ev: "session_usage", session: "missing", input: "" }),
      line({ ev: "plugin_load", harness: "oh-my-pi", capture: "off" }),
      line({
        ev: "session_usage",
        ts: new Date(NOW + 1000).toISOString(),
        session: "future",
        input: 100,
        read: 0,
        write: 0,
        output: 0,
        reasoning: 0,
      }),
      line({
        ev: "session_usage",
        ts: "2020-01-01T00:00:00Z",
        session: "expired",
        input: 100,
        read: 0,
        write: 0,
        output: 0,
        reasoning: 0,
      }),
      "not a record",
      line({ ev: "capture_cost", ts: "bad-date", prompt_chars: 40 }),
    ],
    [],
    30,
    NOW,
  );
  expect(stats.total.usage).toBeNull();
  expect(stats.total.capture.calls).toBe(0);
  expect(harnessActivityLines(stats).join("\n")).toInclude("not reported");
  expect(summarizeHarnessActivity([], [], 30, NOW).since).toBeNull();
});
