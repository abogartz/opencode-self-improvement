// Pins the plugin-side contract for a capture pass's evidence lines: the start
// receipt, the deliberate-skip line, and the disposal flush. These tests stub
// the event bus and assert the lines the plugin writes; whether the host lets a
// pass finish (delivery) is exercised by the flaky e2e capture test, not here.
//
// The contract:
//   `auto_capture_start` is written synchronously AFTER the context read and
//     every skip decision, immediately before the model call. It means exactly
//     one thing: the pass reached the model call. A pass disposed during the
//     context read returns at its abort check and leaves no trace (the teardown
//     contract), so this line is never written before the context read.
//   `auto_capture_skipped` is written when a turn deliberately skips (no signal,
//     thin transcript); no start line is written, because a skip is not a cut.
//   `auto_capture_dispose` is written at disposal when an armed instance observed
//     no turn-end event and started no pass. It is predictive, not observed on a
//     released host, and an idle restart between turns produces it too.
//
// The states a reader distinguishes from the evidence log:
//   ran to a verdict              -> auto_capture_start + capture_cost/capture_lag
//   deliberately skipped          -> auto_capture_skipped, no start line
//   reached the model, no verdict -> auto_capture_start, no capture_cost
//   disposed, no turn-end seen    -> auto_capture_dispose, no start line
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { resetCaptureCooldowns } from "../../src/index.ts";
import { evidenceDir } from "../../src/core/config/paths.ts";
import { dateStr } from "../../src/core/time.ts";
import { captureHealth } from "../../src/status/metrics.ts";
import { captureLines } from "../../src/status/report.ts";
import { type LoadedPlugin, loadPlugin } from "../harness.ts";
import { readEvidenceLog, sleep } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let plugin: LoadedPlugin | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-start-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(join(root, "repo"), { recursive: true });
  resetState();
  resetCaptureCooldowns();
  setRepoScope(null);
});

afterEach(async () => {
  await plugin?.cleanup();
  plugin = undefined;
  resetState();
  resetCaptureCooldowns();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

/** The raw evidence lines, as `captureHealth` reads them. */
function rawLines(): string[] {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
    : [];
}

/** A generate call the test holds open, then releases. */
function parked(): { promise: Promise<void>; release: () => void } {
  const box = { promise: Promise.resolve(), release: () => {} };
  box.promise = new Promise<void>((resolve) => {
    box.release = resolve;
  });
  return box;
}

// A context thick enough to mine (>=200 chars) so the idle pass reaches the
// model instead of skipping on a thin transcript — the pass must be cut AT the
// model call to reproduce the lost-pass signature, not skipped before it.
function thickMessages(): unknown[] {
  return [
    {
      role: "user",
      content:
        "We finished the archive change. Remember that the nightly archive job keeps fourteen " +
        "days of tarballs, and the batch importer respects the staging rate limit of 120 " +
        "requests per minute per key as of October 2026, which matters for the importer.",
    },
    {
      role: "assistant",
      content:
        "Got it: fourteen days of tarballs in the nightly archive, and I will respect the " +
        "120 requests per minute staging limit while wiring the batch importer tooling.",
    },
  ];
}

test("a pass cut at the model call records auto_capture_start and no capture_cost", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  const sid = "ses-start-cut";
  loaded.capture.context.messages = thickMessages();
  const park = parked();
  loaded.capture.generate.park = park.promise;
  loaded.capture.generate.response = JSON.stringify([
    { type: "context", scope: "batch", content: "unused" },
  ]);
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  loaded.capture.events.push({
    type: "session.execution.succeeded",
    data: { sessionID: sid },
  });
  // The pass is now parked INSIDE generate.text: it began, but cannot reach
  // capture_cost — exactly the state the host leaves on a fast-exiting run.
  await waitFor(() => loaded.capture.generate.calls.length === 1);

  const ev = readEvidenceLog();
  const start = ev.find((l) => l.ev === "auto_capture_start");
  // The receipt is the only trace a cut pass leaves, so it must be present.
  expect(start).toBeDefined();
  expect(String(start?.trigger)).toBe("idle");
  // The pass really was cut before its verdict: no completion receipt exists.
  expect(ev.some((l) => l.ev === "capture_cost")).toBe(false);
  park.release();
});

test("a deliberately skipped turn records no start line and is not reported as a cut", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  const sid = "ses-skip";
  // A one-message transcript: too thin to mine, so the pass skips on purpose.
  loaded.capture.context.messages = [{ role: "user", content: "hello" }];
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  loaded.capture.events.push({
    type: "session.execution.succeeded",
    data: { sessionID: sid },
  });
  await waitFor(() =>
    readEvidenceLog().some((l) => l.ev === "auto_capture_skipped"),
  );

  const ev = readEvidenceLog();
  // The pass skipped before the model call, so no model request was made.
  expect(loaded.capture.generate.calls.length).toBe(0);
  expect(ev.some((l) => l.ev === "auto_capture_skipped")).toBe(true);
  // The invariant: a deliberate skip writes NO start line. `auto_capture_start`
  // means "the pass reached the model call," so writing it here would make a
  // healthy skip indistinguishable from a pass cut mid-model-call.
  expect(ev.some((l) => l.ev === "auto_capture_start")).toBe(false);
  // And the rendered health must not diagnose this healthy skip as a lost pass.
  const rendered = captureLines(captureHealth(rawLines())).join("\n");
  expect(rendered).not.toMatch(
    /started|reached the model call|cut by host teardown/,
  );
});

test("disposal of an armed instance with no turn-end event records auto_capture_dispose", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  // No turn-end event is ever delivered. Disposal is the only chance to record
  // the absence — a predictive line, not an accusation of where an event went.
  await loaded.cleanup();
  plugin = undefined; // already disposed; do not double-flush in afterEach

  const miss = readEvidenceLog().find((l) => l.ev === "auto_capture_dispose");
  expect(miss).toBeDefined();
  expect(String(miss?.reason)).toBe("no_turn_end_observed");
  expect(String(miss?.armed)).toBe("true");
});
