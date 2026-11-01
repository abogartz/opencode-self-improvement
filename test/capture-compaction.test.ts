// Contract: opt-in auto-capture at the COMPACTION moment (issue #41, epic #82).
//
// Compaction is where episodic detail dies (Compaction Cliff: one round keeps
// 53% of exact-wording rules), so the session.compaction hook additionally
// feeds the SAME capture pipeline the idle trigger uses: one generate.text
// call, parseCandidates, runWriteGate — never a direct store write. Rows land
// tagged auto-capture + auto_capture_compaction and evidence lands as
// auto_capture_compaction_<action> so decay/status can tell triggers apart.
//
// These tests replay the compaction event through the REAL hook (the harness
// registers the plugin's actual session.compaction handler) and pin:
//   - the fix: compaction fires capture, rows land through the gate, the hook
//     payload transcript (not a context re-read) is mined, and the payload is
//     never mutated (RED on src without the compaction trigger);
//   - the negative control: no compaction event -> nothing captured;
//   - zero-token default: options OFF -> hook stays model-free;
//   - captureOnCompact:false isolates the trigger (idle keeps working);
//   - a per-session cooldown bounds repeated compactions, and the cooldown is
//     per-trigger (an idle right after compaction still captures);
//   - hosts whose hook payload carries no messages fall back to
//     session.context — the envelope lesson of PR #79;
//   - the trigger adds NO new event subscription, and cleanup makes the hook
//     inert again.
// Hermetic: temp OPENCODE_MEMORY_DIR / OPENCODE_COMMANDS_DIR.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evidenceDir, memoryRoot } from "../src/core/config/paths.ts"
import { dateStr } from "../src/core/time.ts";
import { formatLine, parseLine, type Fields } from "../src/core/logfmt/format.ts";
import { resetState } from "../src/core/state.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { loadAll } from "../src/store/files/load.ts"
import { isActive } from "../src/store/model/predicates.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-capture-compact-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
  resetCaptureCooldowns(); // cooldown truth is module-level since #108 - and bun test shares module state across files, so a fresh test needs this explicit clear
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function seed(type: string, scope: string, content: string): void {
  const file = join(memoryRoot(), `${new Date().toISOString().split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, formatLine({ ts: new Date().toISOString(), type, scope, content }) + "\n");
}

function evidence(): Fields[] {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseLine(l))
    .filter((f): f is Fields => f !== null);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

// Replay the V2 session.compaction hook event (SessionCompaction shape:
// { sessionID, system, messages }) through the plugin's registered hook.
async function driveCompaction(
  loaded: LoadedPlugin,
  sessionID: string,
  messages?: unknown,
): Promise<{ system: Array<{ type: string; text: string }> }> {
  const event = { sessionID, system: [] as Array<{ type: string; text: string }>, messages };
  await loaded.sessionHooks["compaction"]?.(event);
  return event;
}

// Ground the session so ref-free candidates promote through the gate's
// behavior-grounding path (identical to the idle-capture tests).
async function ground(loaded: LoadedPlugin, sessionID: string): Promise<void> {
  await loaded["tool.execute.after"](
    { tool: "read", sessionID, callID: "C1", args: { filePath: "x.ts" } },
    { title: "read", output: "content", metadata: {} },
  );
}

const DUP_CONTENT = "Alpha builds are run with make all from the repository root directory.";
const FRESH_CONTENT = "The staging API rate limit is 120 requests per minute per key as of October 2026.";
// A second genuinely-new payload: in the two-setups idle test BOTH canned replies
// must append, so the store assertion does not depend on which loop wins the
// shared cooldown (#117).
const FRESH_CONTENT_B = "The nightly archive job runs at 02:30 UTC and keeps fourteen days of tarballs.";

// A pre-compaction transcript: both facts are still spelled out verbatim —
// exactly the detail the summarizer is about to lose.
function thickMessages(): unknown[] {
  return [
    {
      role: "user",
      content:
        "We finished the alpha build switch. Remember that alpha builds are run with make all " +
        "from the repository root directory. Also the staging API rate limit is 120 requests " +
        "per minute per key as of October 2026, which matters for the batch importer.",
    },
    {
      role: "assistant",
      content:
        "Got it: make all from the repository root for alpha builds, and I will respect the " +
        "120 requests per minute staging limit while wiring the batch importer.",
    },
  ];
}

const THICK_TEXT =
  "We finished the alpha build switch. Remember that alpha builds are run with make all from " +
  "the repository root directory. Also the staging API rate limit is 120 requests per minute " +
  "per key as of October 2026, which matters for the batch importer tooling we ship next week.";

describe("auto-capture end-to-end (session.compaction hook -> gate)", () => {
  test("compaction mines the hook transcript through the gate; rows land tagged per trigger", async () => {
    seed("pattern", "build", DUP_CONTENT); // the dupe target, already in the store
    const loaded = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    await ground(loaded, "ses-cc");
    loaded.capture.generate.response = JSON.stringify([
      { type: "pattern", scope: "build", content: DUP_CONTENT }, // exact dupe of the seeded row
      { type: "learning", scope: "api", content: FRESH_CONTENT }, // genuinely new
    ]);

    const messages = thickMessages();
    const before = JSON.stringify(messages);
    const event = await driveCompaction(loaded, "ses-cc", messages);
    await waitFor(
      () =>
        evidence().some((l) => l.ev === "auto_capture_compaction_collapsed") &&
        evidence().some((l) => l.ev === "auto_capture_compaction_promoted"),
    );

    // Exactly ONE new active memory, the fresh one, tagged for BOTH the shared
    // provenance path and the compaction trigger.
    const mems = (await loadAll()).filter(isActive);
    const captured = mems.filter((m) => m.tags?.includes("auto_capture_compaction"));
    expect(captured.length).toBe(1);
    expect(captured[0].content).toBe(FRESH_CONTENT);
    expect(captured[0].tags).toContain("auto-capture");
    // Conservation: one seeded row + the single promoted row; the dupe did NOT
    // write a second row (gate collapsed it, not capture).
    expect(mems.filter((m) => m.content === DUP_CONTENT).length).toBe(1);
    expect(mems.length).toBe(2);

    // Evidence: the trigger names the line, the trigger field groups it.
    const lines = evidence().filter((l) => String(l.ev).startsWith("auto_capture_compaction_"));
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l.session === "ses-cc" && l.trigger === "compaction")).toBe(true);

    // The hook payload is the transcript source: one model call carrying the
    // pre-compaction detail, and NO session.context re-read.
    expect(loaded.capture.generate.calls.length).toBe(1);
    expect(loaded.capture.generate.calls[0].model).toEqual({ providerID: "fake", id: "model" });
    expect(loaded.capture.generate.calls[0].prompt).toContain("make all");
    expect(loaded.capture.context.calls.length).toBe(0);

    // The hook contract holds while capture is live: payload never mutated,
    // no result set (the summarizer still runs), and the memory anchor still
    // rides along for the summarizer model.
    expect(JSON.stringify(messages)).toBe(before);
    expect((event as Record<string, unknown>).result).toBeUndefined();
    const anchor = event.system.map((p) => p.text).join("\n");
    expect(anchor).toContain("make all");

    await loaded.cleanup();
  });

  test("negative control: no compaction event -> nothing is captured", async () => {
    const loaded = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.context.messages = [{ role: "user", content: THICK_TEXT }];
    loaded.capture.generate.response = JSON.stringify([
      { type: "learning", scope: "api", content: FRESH_CONTENT },
    ]);
    await sleep(100); // let any (mis)wired listener spin

    expect(loaded.capture.generate.calls.length).toBe(0);
    expect(loaded.capture.context.calls.length).toBe(0);
    expect(evidence().some((l) => String(l.ev).startsWith("auto_capture_"))).toBe(false);
    expect((await loadAll()).some((m) => m.tags?.includes("auto_capture_compaction"))).toBe(false);

    await loaded.cleanup();
  });

  test("zero-token default: with options OFF the compaction hook never calls the model", async () => {
    const loaded = await loadPlugin(liveRoot, { captureOnCompact: true }); // no autoCapture
    await driveCompaction(loaded, "ses-off", thickMessages());
    await sleep(50);
    expect(loaded.capture.generate.calls.length).toBe(0);
    expect(loaded.capture.context.calls.length).toBe(0);
    expect(evidence().some((l) => String(l.ev).startsWith("auto_capture_"))).toBe(false);
    // autoCapture is the master switch: captureOnCompact alone subscribes nothing
    expect(loaded.capture.events.subscribeCalls).toBe(1); // measured listener only
    await loaded.cleanup();
  });

  test("captureOnCompact:false isolates the trigger; idle capture keeps working", async () => {
    const loaded = await loadPlugin(liveRoot, {
      autoCapture: true,
      captureModel: "fake/model",
      captureOnCompact: false,
    });
    await driveCompaction(loaded, "ses-cc-off", thickMessages());
    await sleep(50);
    expect(loaded.capture.generate.calls.length).toBe(0);
    expect(evidence().some((l) => String(l.ev).startsWith("auto_capture_compaction_"))).toBe(false);

    // Same options, idle trigger: still captures, and the row is NOT tagged
    // as compaction-triggered.
    await ground(loaded, "ses-cc-off");
    loaded.capture.context.messages = [{ role: "user", content: THICK_TEXT }];
    loaded.capture.generate.response = JSON.stringify([
      { type: "learning", scope: "api", content: FRESH_CONTENT },
    ]);
    loaded.capture.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses-cc-off" } });
    await waitFor(() => evidence().some((l) => l.ev === "auto_capture_promoted"));

    expect(loaded.capture.generate.calls.length).toBe(1);
    expect(evidence().some((l) => String(l.ev).startsWith("auto_capture_compaction_"))).toBe(false);
    const row = (await loadAll()).find((m) => m.content === FRESH_CONTENT);
    expect(row?.tags).toContain("auto-capture");
    expect(row?.tags ?? []).not.toContain("auto_capture_compaction");

    await loaded.cleanup();
  });

  test("cooldown bounds repeated compactions; triggers keep separate cooldowns", async () => {
    const loaded = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    await ground(loaded, "ses-cool");
    loaded.capture.generate.response = JSON.stringify([
      { type: "learning", scope: "api", content: FRESH_CONTENT },
    ]);

    await driveCompaction(loaded, "ses-cool", thickMessages());
    await waitFor(() => evidence().some((l) => l.ev === "auto_capture_compaction_promoted"));
    expect(loaded.capture.generate.calls.length).toBe(1);

    // A second compaction in the same session, inside the cooldown: skipped.
    await driveCompaction(loaded, "ses-cool", thickMessages());
    await sleep(100);
    expect(loaded.capture.generate.calls.length).toBe(1);
    expect(evidence().filter((l) => l.ev === "auto_capture_compaction_promoted").length).toBe(1);

    // Separate per-trigger cooldown: an idle right after compaction still
    // fires (the mined fact is now a store dupe, so the gate collapses it —
    // evidence lands as trigger=idle, naming the idle path).
    loaded.capture.context.messages = [{ role: "user", content: THICK_TEXT }];
    loaded.capture.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses-cool" } });
    await waitFor(() => evidence().some((l) => l.ev === "auto_capture_collapsed"));
    expect(loaded.capture.generate.calls.length).toBe(2);
    const collapsed = evidence().find((l) => l.ev === "auto_capture_collapsed");
    expect(collapsed?.trigger).toBe("idle");

    await loaded.cleanup();
  });

  test("hosts without hook messages fall back to session.context (PR #79 lesson)", async () => {
    const loaded = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    await ground(loaded, "ses-legacy");
    loaded.capture.context.messages = [{ role: "user", content: THICK_TEXT }];
    loaded.capture.generate.response = JSON.stringify([
      { type: "learning", scope: "api", content: FRESH_CONTENT },
    ]);

    // Legacy-shape hook event: no messages field at all.
    await driveCompaction(loaded, "ses-legacy", undefined);
    await waitFor(() => evidence().some((l) => l.ev === "auto_capture_compaction_promoted"));
    expect(loaded.capture.context.calls).toEqual(["ses-legacy"]);
    expect(loaded.capture.generate.calls.length).toBe(1);

    await loaded.cleanup();
  });

  test("a thin transcript on both paths mines nothing (no model call)", async () => {
    const loaded = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    loaded.capture.context.messages = [{ role: "user", content: "too short to mine" }];
    await driveCompaction(loaded, "ses-thin", [{ role: "user", content: "also short" }]);
    await waitFor(() => loaded.capture.context.calls.length === 1);
    await sleep(50);
    expect(loaded.capture.generate.calls.length).toBe(0);
    expect(evidence().some((l) => String(l.ev).startsWith("auto_capture_compaction_"))).toBe(false);
    await loaded.cleanup();
  });

  test("no extra subscription; cleanup makes the compaction trigger inert", async () => {
    const loaded = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    expect(loaded.capture.events.signals.length).toBe(2); // measured + idle capture

    await loaded.cleanup();
    expect(loaded.capture.events.signals.every((s) => s.aborted)).toBe(true);

    loaded.capture.context.messages = [{ role: "user", content: THICK_TEXT }];
    loaded.capture.generate.response = JSON.stringify([
      { type: "learning", scope: "api", content: FRESH_CONTENT },
    ]);
    await driveCompaction(loaded, "ses-post", thickMessages());
    await sleep(50);
    expect(loaded.capture.generate.calls.length).toBe(0);
    expect(loaded.capture.context.calls.length).toBe(0);

    // The hook contract (T2 rollup + anchor) still runs after cleanup.
    expect(evidence().some((l) => l.ev === "t2_compaction")).toBe(true);
  });
});

// #108: cooldown state used to live inside setup()'s closure, and the file's
// own Bun-floor comment records that setup runs for more than one location.
// Two live registrations meant one compaction reached two cooldown maps that
// were strangers: two generate.text calls on one transcript - the gate
// collapses the duplicate rows, so store state was safe while the TOKENS
// were not. The truth is now module-level (the `turns` shape from lock.ts),
// keyed `${trigger}:${sid}`.
describe("cooldown shared across setup() registrations (#108)", () => {
  test("one compaction, two live setups, exactly ONE model call", async () => {
    seed("pattern", "build", DUP_CONTENT);
    const a = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    const b = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    await ground(a, "ses-twin");
    a.capture.generate.response = JSON.stringify([{ type: "learning", scope: "api", content: FRESH_CONTENT }]);
    b.capture.generate.response = JSON.stringify([{ type: "learning", scope: "api", content: FRESH_CONTENT }]);

    // A real host dispatches ONE compaction to every registered plugin; this
    // is exactly that, across the two registrations sharing one module.
    const messages = thickMessages();
    await a.sessionHooks["compaction"]?.({ sessionID: "ses-twin", system: [], messages });
    await b.sessionHooks["compaction"]?.({ sessionID: "ses-twin", system: [], messages });
    await waitFor(() => evidence().some((l) => String(l.ev).startsWith("auto_capture_compaction_")));
    await sleep(100); // a second, uncooled fire would have reached generate by now

    // Red pre-fix: BOTH setups' fresh cooldown maps let BOTH pay for the same
    // transcript (2 calls). The rows would have collapsed - the bug is the
    // spend, invisible in the store.
    expect(a.capture.generate.calls.length + b.capture.generate.calls.length).toBe(1);
    expect((await loadAll()).filter(isActive).length).toBe(2); // seed + ONE promotion
  });

  test("an idle broadcast reaches every live subscription, and pays exactly ONE model call", async () => {
    seed("pattern", "build", DUP_CONTENT);
    const a = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    const b = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    await ground(b, "ses-twin-idle");
    // Both replies are genuinely new: the harness bus queues both subscribers
    // independently, so which loop wins the shared cooldown is scheduling luck -
    // with a DUP twin on either side, a collapse could legitimately leave the
    // store at one row and the assertion was red on correct code (#117). The
    // one-spend invariant this test pins is the CALL COUNT, not the content.
    a.capture.generate.response = JSON.stringify([{ type: "learning", scope: "api", content: FRESH_CONTENT }]);
    b.capture.generate.response = JSON.stringify([{ type: "learning", scope: "ops", content: FRESH_CONTENT_B }]);
    const idleTranscript = [
      {
        role: "user",
        content:
          "We finished the alpha build switch. Remember that alpha builds are run with make all " +
          "from the repository root directory. Also the staging API rate limit is 120 requests " +
          "per minute per key as of October 2026, which matters for the batch importer.",
      },
    ];
    a.capture.context.messages = idleTranscript;
    b.capture.context.messages = idleTranscript;

    // The event bus broadcasts the turn-end event to EVERY live subscription -
    // pre-fix, each subscription carried its own cooldown closure, so both
    // loops passed their own check and BOTH paid for one transcript (red).
    // Post-fix they share one truth: the first loop through the door records
    // the fire and the other skips.
    a.capture.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses-twin-idle" } });
    b.capture.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses-twin-idle" } });
    // Completion signal: the evidence line is recorded after runWriteGate
    // returns, i.e. once the append has hit disk. The naked sleep this replaces
    // doubled as the whole append budget and lost it on a loaded Windows
    // runner; the compaction twin above already waits on evidence (#117).
    await waitFor(() => evidence().some((l) => String(l.ev).startsWith("auto_capture_")));
    expect(a.capture.generate.calls.length + b.capture.generate.calls.length).toBe(1);
    await sleep(150); // a second, uncooled fire would have reached generate by now
    expect(a.capture.generate.calls.length + b.capture.generate.calls.length).toBe(1);
    expect((await loadAll()).filter(isActive).length).toBe(2); // seed + the winner's row
  });
});
