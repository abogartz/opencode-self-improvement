// Contract (#211, LIFE-1): auto-capture work that is in flight when the host
// disposes the plugin instance must not keep running the write gate.
//
// The reproducer the review ran was throwaway; this is the checked-in version.
// `generate.text` does not take the abort signal, so before the fix a pass
// parked mid-model-call woke up after `cleanup()` and ran the whole gate
// against a store its caller had already torn down — gate_start, ref_stale_scan,
// write_blocked/auto_capture_*_promoted, capture_lag, all with timestamps AFTER
// disposal. A passing candidate (or a GATE-2 supersession) mutates the store
// there, and the same gap produced the `hook failed (ignored): ENOENT
// .../evidence/<date>.logfmt` noise in security-capture-crop's teardown.
//
// The contract, as implemented in src/capture/runtime.ts:
//   1. cleanup aborts the subscription — no NEW pass starts;
//   2. a pass checks the signal after EACH await that can outlive teardown —
//      the context read, the known-rows read, the model call — and between
//      candidates, and stops BEFORE the next gate run (a gate already mutating
//      is never cut in half);
//   3. cleanup drains the tracked passes up to a bound, so a caller that
//      removes the store right after cleanup sees nothing straggling.
// Hermetic: temp OPENCODE_MEMORY_DIR / OPENCODE_COMMANDS_DIR.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetState } from "../src/core/state.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { loadAll } from "../src/store/files/load.ts";
import { isActive } from "../src/store/model/predicates.ts";
import { type LoadedPlugin, loadPlugin } from "./harness.ts";
import { readEvidenceLog, sleep } from "./helpers/logfmt.ts";

let root: string;
let plugin: LoadedPlugin | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-211-dispose-"));
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
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

/** A generate call the test holds open, then releases after disposal. */
function parked(): { promise: Promise<void>; release: () => void } {
  const box = { promise: Promise.resolve(), release: () => {} };
  box.promise = new Promise<void>((resolve) => {
    box.release = resolve;
  });
  return box;
}

// Grounded so the canned candidate really would promote: the point of the
// first test is that NO row lands, which is only evidence when a row was
// available to land.
const CANDIDATE = JSON.stringify([
  {
    type: "context",
    scope: "batch",
    content: "The nightly archive job keeps fourteen days of tarballs.",
    status: "settled",
  },
]);

// A pre-compaction transcript thick enough to mine (>=200 chars).
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

async function ground(loaded: LoadedPlugin, sessionID: string): Promise<void> {
  await loaded["tool.execute.after"](
    { tool: "read", sessionID, callID: "C1", args: { filePath: "x.ts" } },
    { title: "read", output: "content", metadata: {} },
  );
}

function capturedRows() {
  return loadAll().then((rows) =>
    rows.filter(
      (r) => isActive(r) && r.tags?.includes("auto-capture") === true,
    ),
  );
}

/** Evidence appended at or after the disposal instant — the leak under test. */
function evidenceSince(ms: number) {
  return readEvidenceLog()
    .filter((l) => Date.parse(String(l.ts)) >= ms)
    .map((l) => String(l.ev));
}

test("compaction pass disposed mid-model-call never reaches the write gate (#211)", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  const sid = "ses-dispose";
  await ground(loaded, sid);
  const park = parked();
  loaded.capture.generate.park = park.promise;
  loaded.capture.generate.response = CANDIDATE;
  await loaded.sessionHooks.compaction?.({
    sessionID: sid,
    system: [],
    messages: thickMessages(),
  });
  await waitFor(() => loaded.capture.generate.calls.length === 1);

  const disposedAt = Date.now();
  await loaded.cleanup();
  park.release(); // the pass wakes AFTER disposal
  await sleep(100);

  expect(await capturedRows()).toEqual([]);
  expect(evidenceSince(disposedAt)).toEqual([]);
});

test("control: the same pass with no disposal does promote (so the check is what stops it)", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  const sid = "ses-alive";
  await ground(loaded, sid);
  loaded.capture.generate.response = CANDIDATE;
  await loaded.sessionHooks.compaction?.({
    sessionID: sid,
    system: [],
    messages: thickMessages(),
  });
  await waitFor(() => loaded.capture.generate.calls.length === 1);
  await sleep(150); // let the pass run the gate

  const rows = await capturedRows();
  expect(rows.length).toBe(1);
  expect(rows[0]?.content).toContain("fourteen days of tarballs");
});

// #404: the other side of the same teardown. The pass above is parked IN the
// model call when cleanup runs, so abandoning it is right. A pass that already
// HOLDS its answer is different work — the gate is local and milliseconds — and
// on `opencode run` nothing is being torn down at all: the process exits. The
// old single-signal drain abandoned those passes too, which is how between a
// quarter and three quarters of real CLI captures recorded `capture_cost` and no
// row (#404, A/B/A on 2026-11-13: 12/12 fixed, 6/12 reverted, 12/12 fixed).
//
// What this pins that the real-host scenario cannot: that `cleanup()` resolves
// with the row already in the store. The scenario asserts the user-visible
// contract — the row survives the host exiting — but that is a race. Here the
// ordering is forced by parking the model and releasing it at a known point, and
// the assertion is checked before any sleep.
test("a pass that already holds its answer is drained, not abandoned (#404)", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  const sid = "ses-survive";
  await ground(loaded, sid);
  const park = parked();
  loaded.capture.generate.park = park.promise;
  loaded.capture.generate.response = CANDIDATE;
  await loaded.sessionHooks.compaction?.({
    sessionID: sid,
    system: [],
    messages: thickMessages(),
  });
  await waitFor(() => loaded.capture.generate.calls.length === 1);
  park.release();
  // `capture_cost` is the first line written after `generate.text` resolves and
  // before the gate, so its presence puts the pass inside the drain window
  // rather than leaving the release-to-cleanup ordering to chance.
  await waitFor(() =>
    readEvidenceLog().some((l) => String(l.ev) === "capture_cost"),
  );

  await loaded.cleanup();

  // Deliberately no sleep first: on the CLI, cleanup resolving is the last
  // moment the store is guaranteed to exist. A pass that needs more than the
  // drain has lost, and this test must fail for that too.
  const rows = await capturedRows();
  expect(rows.length).toBe(1);
  expect(rows[0]?.content).toContain("fourteen days of tarballs");
  // The gate really ran, rather than a row appearing by some other route.
  // `write_promoted` is the gate's own line; the trigger-qualified receipt is
  // `auto_capture_compaction_promoted` here, not `auto_capture_promoted`.
  expect(readEvidenceLog().some((l) => l.ev === "write_promoted")).toBe(true);
  expect(readEvidenceLog().some((l) => l.ev === "capture_lag")).toBe(true);
});

// The pre-model path (#211 review): the first abort check sat after the model
// call, so a pass parked in `session.context` woke up AFTER cleanup() returned
// (the drain expires at its bound rather than hanging on a call that will never
// land) and then either appended a skip receipt or started a model call against
// a store its caller had already torn down.
test("pass disposed during the context read neither receipts nor generates (#211)", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  loaded.capture.context.messages = thickMessages();
  const park = parked();
  loaded.capture.context.park = park.promise;
  loaded.capture.generate.response = "[]";
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  loaded.capture.events.push({
    type: "session.execution.succeeded",
    data: { sessionID: "ses-ctx-dead" },
  });
  await waitFor(() => loaded.capture.context.calls.length === 1);

  const disposedAt = Date.now();
  await loaded.cleanup();
  park.release(); // the context read resolves AFTER disposal
  await sleep(100);

  expect(loaded.capture.generate.calls.length).toBe(0);
  expect(evidenceSince(disposedAt)).toEqual([]);
});

// The same teardown, reached through the OTHER trigger. The idle path catches
// its own failure and checks the signal there; the compaction path runs through
// the generic `guarded()` reporter, so a rejection that wakes after cleanup
// bypassed every abort check and appended a `hook_error` line to a store its
// caller had already torn down (#211 review, adversarial round).
test("compaction pass whose model call fails after disposal reports nothing (#211)", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  const sid = "ses-compact-dead";
  await ground(loaded, sid);
  const park = parked();
  loaded.capture.generate.park = park.promise;
  loaded.capture.generate.throws = new Error("model gone");
  await loaded.sessionHooks.compaction?.({
    sessionID: sid,
    system: [],
    messages: thickMessages(),
  });
  await waitFor(() => loaded.capture.generate.calls.length === 1);

  const disposedAt = Date.now();
  await loaded.cleanup();
  park.release(); // the parked call REJECTS after cleanup returned
  await sleep(100);

  expect(evidenceSince(disposedAt)).toEqual([]);
});

// The receipt itself stays: a compaction failure with a live plugin is exactly
// the invisible-failure class #138 exists for, so suppressing it must be scoped
// to teardown and nothing else.
test("control: a compaction failure with no disposal still reports hook_error (#138)", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  const sid = "ses-compact-alive";
  await ground(loaded, sid);
  loaded.capture.generate.throws = new Error("model gone");
  await loaded.sessionHooks.compaction?.({
    sessionID: sid,
    system: [],
    messages: thickMessages(),
  });
  await waitFor(() => loaded.capture.generate.calls.length === 1);
  await sleep(150);

  const errors = readEvidenceLog().filter((l) => l.ev === "hook_error");
  expect(errors.length).toBe(1);
  expect(String(errors[0]?.hook)).toContain("compaction");
});

test("idle pass whose model call fails after disposal writes no failure receipt (#211)", async () => {
  const loaded = await loadPlugin(root, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  plugin = loaded;
  loaded.capture.context.messages = thickMessages();
  const park = parked();
  loaded.capture.generate.park = park.promise;
  loaded.capture.generate.throws = new Error("model gone");
  await waitFor(() => loaded.capture.events.subscribeCalls === 2);
  loaded.capture.events.push({
    type: "session.execution.succeeded",
    data: { sessionID: "ses-idle-dead" },
  });
  await waitFor(() => loaded.capture.generate.calls.length === 1);

  const disposedAt = Date.now();
  await loaded.cleanup();
  park.release(); // the parked call throws AFTER disposal
  await sleep(100);

  // No auto_capture_refused, no capture_lag, nothing at all after cleanup.
  expect(evidenceSince(disposedAt)).toEqual([]);
});
