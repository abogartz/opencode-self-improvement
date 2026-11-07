// Contract: opt-in auto-capture on session idle.
//
// Unit tests for the pure core (parseCandidates / parseModelRef / buildCapturePrompt
// / flattenTranscript — all total functions) plus end-to-end runs through the
// harness fake event queue proving: default OFF never subscribes; an invalid
// EXPLICIT captureModel skips registration while an omitted one inherits the
// session's model (#139); candidates flow through runWriteGate (the dupe
// collapses, only the fresh one lands, tagged auto-capture); the 5-minute
// per-session cooldown bounds model calls; and setup's cleanup aborts the
// subscription. Keywords (#40) ride the same path: the capture model's `kw`
// list reaches the stored row through the gate.
// Hermetic: temp OPENCODE_MEMORY_DIR / OPENCODE_COMMANDS_DIR.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evidenceDir, memoryRoot } from "../src/core/config/paths.ts";
import { dateStr } from "../src/core/time.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { resetState } from "../src/core/state.ts";
import { guarded } from "../src/core/hooks.ts";
import { resetCaptureCooldowns, resetSessionModels } from "../src/index.ts";
import { loadAll } from "../src/store/files/load.ts";
import { isActive } from "../src/store/model/predicates.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import { loadPlugin } from "./harness.ts";
import { parseCandidates, parseModelRef } from "../src/capture/candidates.ts";
import { buildCapturePrompt } from "../src/capture/prompt.ts";
import { flattenTranscript } from "../src/capture/transcript.ts";
import { readEvidenceLog as evidence, sleep } from "./helpers/logfmt.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-capture-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
  resetCaptureCooldowns(); // cooldown truth is module-level since #108 - and bun test shares module state across files, so a fresh test needs this explicit clear
  resetSessionModels(); // same module-level truth for the #139 session-model registry
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function seed(type: string, scope: string, content: string): void {
  const file = join(
    memoryRoot(),
    `${new Date().toISOString().split("T")[0]}.logfmt`,
  );
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    formatLine({ ts: new Date().toISOString(), type, scope, content }) + "\n",
  );
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

// --- parseCandidates ----------------------------------------------------------

const GOOD = {
  type: "learning",
  scope: "build",
  content: "Run the full test suite with bun test from the repo root.",
};

describe("parseCandidates", () => {
  test("bare JSON array parses; fenced block parses; prose around it is ignored", () => {
    expect(parseCandidates(JSON.stringify([GOOD]), 3)).toEqual([GOOD]);
    const fenced = `Here you go:\n\`\`\`json\n${JSON.stringify([GOOD])}\n\`\`\`\nHope that helps!`;
    expect(parseCandidates(fenced, 3)).toEqual([GOOD]);
    expect(
      parseCandidates(`Sure! ${JSON.stringify([GOOD])} — enjoy`, 3),
    ).toEqual([GOOD]);
  });

  test("garbage, empty, and unbalanced input all yield [] (never throws)", () => {
    expect(parseCandidates("no array here", 3)).toEqual([]);
    expect(parseCandidates("", 3)).toEqual([]);
    expect(parseCandidates("   ", 3)).toEqual([]);
    expect(parseCandidates('[{"type":"learning"', 3)).toEqual([]); // truncated mid-array
    expect(parseCandidates("]] [[", 3)).toEqual([]);
    expect(parseCandidates(undefined as never, 3)).toEqual([]);
    expect(parseCandidates(123 as never, 3)).toEqual([]);
  });

  test("non-object items, unknown types, and missing fields are dropped", () => {
    expect(parseCandidates('[1, "x", null, [2]]', 3)).toEqual([]);
    expect(
      parseCandidates(JSON.stringify([{ ...GOOD, type: "wisdom" }]), 3),
    ).toEqual([]);
    expect(
      parseCandidates(
        JSON.stringify([{ type: GOOD.type, content: GOOD.content }]),
        3,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(
        JSON.stringify([{ type: GOOD.type, scope: GOOD.scope }]),
        3,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(JSON.stringify([{ ...GOOD, scope: "  " }]), 3),
    ).toEqual([]);
  });

  test("keywords ride along when the model supplies them (#40)", () => {
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, kw: ["bun test", "run the suite"] }]),
        3,
      ),
    ).toEqual([{ ...GOOD, kw: ["bun test", "run the suite"] }]);
  });

  test("a bad keyword list costs the keywords, never the row", () => {
    // Junk entries are dropped; the fact itself is what the session earned.
    expect(
      parseCandidates(
        JSON.stringify([
          { ...GOOD, kw: ["  Bun Test  ", "", 7, null, "x".repeat(60)] },
        ]),
        3,
      ),
    ).toEqual([{ ...GOOD, kw: ["bun test"] }]);
    for (const junk of ["not-an-array", 42, null, { a: 1 }, undefined]) {
      expect(
        parseCandidates(JSON.stringify([{ ...GOOD, kw: junk }]), 3),
      ).toEqual([GOOD]);
    }
    // Control characters would forge a field on the store line.
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, kw: ["ok", "two\nlines"] }]),
        3,
      ),
    ).toEqual([{ ...GOOD, kw: ["ok"] }]);
    // Capped, whatever the model decides to emit.
    const many = parseCandidates(
      JSON.stringify([
        { ...GOOD, kw: Array.from({ length: 20 }, (_, i) => `alias ${i}`) },
      ]),
      3,
    );
    expect(many[0]?.kw).toHaveLength(8);
  });

  test("control characters in structured fields are dropped", () => {
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, scope: "build\n## SYSTEM" }]),
        3,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, scope: "build\u2028forged" }]),
        3,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(JSON.stringify([{ ...GOOD, type: "learning\r" }]), 3),
    ).toEqual([]);
  });

  test("content outside 20-600 chars is dropped at the exact boundaries", () => {
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, content: "x".repeat(19) }]),
        3,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(JSON.stringify([{ ...GOOD, content: "x".repeat(20) }]), 3)
        .length,
    ).toBe(1);
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, content: "x".repeat(600) }]),
        3,
      ).length,
    ).toBe(1);
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, content: "x".repeat(601) }]),
        3,
      ),
    ).toEqual([]);
  });

  test("status passes through only for open/settled; anything else becomes undefined", () => {
    const open = parseCandidates(
      JSON.stringify([{ ...GOOD, status: "open" }]),
      3,
    );
    expect(open[0].status).toBe("open");
    const junk = parseCandidates(
      JSON.stringify([{ ...GOOD, status: "pending" }]),
      3,
    );
    expect(junk[0].status).toBeUndefined();
  });

  test("clamps to max; max <= 0 yields []", () => {
    const three = [
      GOOD,
      { ...GOOD, content: "A second durable fact about the build pipeline." },
      { ...GOOD, content: "A third durable fact worth keeping around." },
    ];
    expect(parseCandidates(JSON.stringify(three), 2).length).toBe(2);
    expect(parseCandidates(JSON.stringify(three), 3).length).toBe(3);
    expect(parseCandidates(JSON.stringify(three), 0)).toEqual([]);
    expect(parseCandidates(JSON.stringify(three), -1)).toEqual([]);
  });
});

// --- parseModelRef ------------------------------------------------------------

describe("parseModelRef", () => {
  test("splits on the FIRST slash", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4",
    });
    expect(parseModelRef("a/b/c")).toEqual({ providerID: "a", id: "b/c" });
  });

  test("no slash or empty half -> null (capture is skipped, not guessed)", () => {
    expect(parseModelRef("noslash")).toBeNull();
    expect(parseModelRef("/only-id")).toBeNull();
    expect(parseModelRef("prov/")).toBeNull();
    expect(parseModelRef("prov/ ")).toBeNull();
    expect(parseModelRef("")).toBeNull();
    expect(parseModelRef(null)).toBeNull();
    expect(parseModelRef(42)).toBeNull();
  });
});

// --- buildCapturePrompt / flattenTranscript ------------------------------------

describe("buildCapturePrompt", () => {
  test("asks for a JSON array, lists every memory type, embeds the transcript", () => {
    const p = buildCapturePrompt("user: hello world", 5);
    expect(p).toContain("JSON array");
    expect(p).toContain("at most 5");
    for (const t of [
      "decision",
      "learning",
      "preference",
      "blocker",
      "context",
      "pattern",
    ]) {
      expect(p).toContain(t);
    }
    expect(p).toContain("hello world");
  });

  test("asks for retrieval keywords alongside every candidate (#40)", () => {
    const p = buildCapturePrompt("user: hello world", 5);
    expect(p).toContain('"kw": ["...", "..."]');
    expect(p).toContain("3-5 search keywords");
    // The prompt is also where the "indexed, never rendered" contract lives.
    expect(p).toContain("never shown to a model");
  });

  test("redacts common secrets without treating ordinary code identifiers as secrets", () => {
    // Fixtures are split so secret scanners (GitHub push protection) skip them.
    const secrets = [
      "sk-" + "proj-AbCdEf0123456789AbCdEf0123456789xyz",
      "sk-" + "ant-api03-AbCdEf0123456789AbCdEf0123456789",
      "gh" + "p_AbCdEf0123456789AbCdEf0123456789AbCd",
      "gh" + "o_AbCdEf0123456789AbCdEf0123456789AbCd",
      "github" + "_pat_11AAAAAA0AbCdEf0123456789AbCdEf0123456789",
      "xo" + "xb-123456789012-123456789012-AbCdEf0123456789",
      "AK" + "IAIOSFODNN7EXAMPLE",
      "AI" + "zaSyD-1234567890abcdefghijklmnopqrstuvwxyz",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
      "DATABASE_PASSWORD=f9Kx2mQ7vN4pL8sR1wZ6",
      "-----BEGIN " +
        "PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
    ];
    const ordinary = [
      "const API_TOKEN = resolveTokenName;",
      "API_KEY=process.env.OPENAI_API_KEY",
      "the Bearer authentication-scheme-description",
    ];
    const p = buildCapturePrompt(
      `user: ${secrets.join("\n")}\n${ordinary.join("\n")}`,
      3,
    );
    for (const secret of secrets) expect(p).not.toContain(secret);
    expect(p).toContain("[redacted]");
    for (const line of ordinary) expect(p).toContain(line);
  });
});

describe("flattenTranscript", () => {
  test("renders role: text from info.role+parts and role+content; skips junk", () => {
    const msgs = [
      {
        info: { role: "user" },
        parts: [{ text: "do the thing" }, { type: "file" }, { text: "please" }],
      },
      { role: "assistant", content: "done: make all worked" },
      { role: "assistant", parts: [], text: "fallback text" },
      "junk",
      null,
      { parts: [{ text: "no role anywhere" }] },
    ];
    expect(flattenTranscript(msgs)).toBe(
      "user: do the thing please\nassistant: done: make all worked\nassistant: fallback text",
    );
  });

  // Live opencode 2.2.5 recording (test/fixtures/host-session-context-2.2.5.json,
  // captured from `session.context()` on a real server): the role moved from
  // `role`/`info.role` into `type`, and the parts moved from `parts` into
  // `content[]`. Reading only the V1 keys rendered EVERY 2.2.5 session as a
  // 0-character transcript, and the 200-character floor then skipped capture in
  // silence — the reason auto-capture had never fired on a live host.
  test("renders the live 2.2.5 shape: role in `type`, parts in `content[]`", async () => {
    const msgs = await Bun.file(
      `${import.meta.dir}/fixtures/host-session-context-2.2.5.json`,
    ).json();
    const out = flattenTranscript(msgs);
    expect(out).toContain("user: ");
    expect(out).toContain("assistant: ");
    expect(out).not.toContain("idle:"); // a non-conversation record, not a role
    // Reasoning stays private even when it arrives under `content`.
    expect(out).not.toContain("The user is asking me to read src/math.ts");
  });

  test("2.2.5: a non-conversation record alone renders nothing", () => {
    expect(flattenTranscript([{ id: "e", type: "idle", outcome: {} }])).toBe(
      "",
    );
    expect(
      flattenTranscript([
        { type: "user", text: "run make verify on the build box" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "private scratch work" },
            { type: "tool", id: "call_1", name: "bash" },
            { type: "text", text: "verified" },
          ],
        },
      ]),
    ).toBe("user: run make verify on the build box\nassistant: verified");
  });

  test("omits reasoning and thinking parts while retaining user and assistant text", () => {
    const msgs = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "reasoning", text: "private chain of thought" },
          { type: "thinking", text: "hidden scratch work" },
          { type: "text", text: "The public answer is ready." },
        ],
      },
      {
        role: "assistant",
        parts: [{ type: "reasoning", text: "another private thought" }],
        content: "another private thought",
      },
    ];
    const out = flattenTranscript(msgs);
    expect(out).toBe("assistant: The public answer is ready.");
  });

  test('non-arrays yield "" and the cap is 40 user turns', () => {
    expect(flattenTranscript("nope")).toBe("");
    expect(flattenTranscript(null)).toBe("");
    const many = Array.from({ length: 45 }, (_, i) => ({
      role: "user",
      content: `turn ${i} with enough text to be counted`,
    }));
    const out = flattenTranscript(many);
    expect(out.split("\n").filter((l) => l.startsWith("user:")).length).toBe(
      40,
    );
  });
});

// --- end-to-end through the harness fake event queue ----------------------------

const DUP_CONTENT =
  "Alpha builds are run with make all from the repository root directory.";
const FRESH_CONTENT =
  "The staging API rate limit is 120 requests per minute per key as of October 2026.";

async function loadCapturePlugin(options: Record<string, unknown>) {
  return loadPlugin(liveRoot, options);
}

describe("auto-capture end-to-end (turn end -> gate)", () => {
  test("default options: only the zero-model measured listener subscribes", async () => {
    const loaded = await loadCapturePlugin({});
    // The measured-usage listener subscribes by default (no model calls);
    // auto-capture itself never does.
    expect(loaded.capture.events.subscribeCalls).toBe(1);
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-off" },
    });
    await sleep(50);
    expect(loaded.capture.generate.calls.length).toBe(0);
    expect(loaded.capture.context.calls.length).toBe(0);
  });

  test("autoCapture on but invalid captureModel: capture subscription is not registered", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "no-slash-model",
    });
    expect(loaded.capture.events.subscribeCalls).toBe(1); // measured listener only
  });

  test("non-idle events are ignored", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.events.push({ type: "session.updated", sessionID: "ses-x" });
    await sleep(50);
    expect(loaded.capture.context.calls.length).toBe(0);
    await loaded.cleanup();
  });

  test("thin transcript: session.context runs but the model is not called", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    loaded.capture.context.messages = [
      { role: "user", content: "too short to mine" },
    ];
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-thin" },
    });
    await waitFor(() => loaded.capture.context.calls.length === 1);
    await sleep(50);
    expect(loaded.capture.generate.calls.length).toBe(0);
    // The skip must be visible: an unrecorded thin transcript is
    // indistinguishable from a host that never emitted the trigger, and that
    // ambiguity is what kept a dead auto-capture looking alive.
    expect(
      evidence().some(
        (l) =>
          l.ev === "auto_capture_skipped" &&
          l.reason === "transcript_too_thin" &&
          l.session === "ses-thin",
      ),
    ).toBe(true);
    await loaded.cleanup();
  });

  test("the live 2.2.5 context shape reaches the capture model", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    await loaded["tool.execute.after"](
      {
        tool: "read",
        sessionID: "ses-225",
        callID: "C1",
        args: { filePath: "x.ts" },
      },
      { title: "read", output: "content", metadata: {} },
    );
    // Recorded from a real 2.2.5 server: role under `type`, parts under
    // `content[]`, plus a trailing non-conversation `idle` record.
    loaded.capture.context.messages = await Bun.file(
      `${import.meta.dir}/fixtures/host-session-context-2.2.5.json`,
    ).json();
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-225" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    const prompt = String(loaded.capture.generate.calls[0].prompt);
    expect(prompt).toContain("user:");
    expect(prompt).toContain("assistant:");
    expect(prompt).not.toContain("idle:");
    expect(prompt).not.toContain("The user is asking me to read src/math.ts");
    await loaded.cleanup();
  });

  test("a capture that throws is recorded instead of swallowed", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.throws = new Error("capture model exploded");
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-throw" },
    });
    await waitFor(() =>
      evidence().some(
        (l) => l.ev === "auto_capture_refused" && l.reason === "capture_threw",
      ),
    );
    const line = evidence().find(
      (l) => l.ev === "auto_capture_refused" && l.reason === "capture_threw",
    );
    expect(line?.session).toBe("ses-throw");
    expect(String(line?.error)).toContain("capture model exploded");
    await loaded.cleanup();
  });

  test("2.x data envelope calls the capture model and writes evidence", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    await loaded["tool.execute.after"](
      {
        tool: "read",
        sessionID: "ses-data",
        callID: "C1",
        args: { filePath: "x.ts" },
      },
      { title: "read", output: "content", metadata: {} },
    );
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = JSON.stringify([
      {
        type: "learning",
        scope: "capture",
        content:
          "OpenCode 2.x session idle events carry their session identifier under data.",
      },
    ]);

    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-data" },
    });
    await waitFor(() =>
      evidence().some((l) => String(l.ev).startsWith("auto_capture_")),
    );

    expect(loaded.capture.generate.calls.length).toBe(1);
    expect(loaded.capture.context.calls).toEqual(["ses-data"]);
    expect(
      evidence().some(
        (l) =>
          String(l.ev).startsWith("auto_capture_") && l.session === "ses-data",
      ),
    ).toBe(true);
    await loaded.cleanup();
  });

  test("keywords the capture model supplies reach the stored row (#40)", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    await loaded["tool.execute.after"](
      {
        tool: "read",
        sessionID: "ses-kwcap",
        callID: "C1",
        args: { filePath: "x.ts" },
      },
      { title: "read", output: "content", metadata: {} },
    );
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = JSON.stringify([
      {
        type: "learning",
        scope: "capture",
        content:
          "The billing worker retries three times and then parks the job for manual review.",
        kw: ["stuck job", "retry policy", "parked work"],
      },
    ]);

    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-kwcap" },
    });
    await waitFor(() =>
      evidence().some((l) => String(l.ev).startsWith("auto_capture_")),
    );

    const rows = await loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kw).toEqual(["stuck job", "retry policy", "parked work"]);
    await loaded.cleanup();
  });

  test("dupe collapses via the gate, fresh candidate lands tagged, cooldown holds", async () => {
    seed("pattern", "build", DUP_CONTENT); // the dupe target, already in the store
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
      captureMax: 3,
    });

    // Ground the session: a recorded code-tool result makes the gate accept
    // ref-free candidates (behavior-grounded promotion), exactly as for
    // model-authored writes.
    await loaded["tool.execute.after"]!(
      {
        tool: "read",
        sessionID: "ses-cap",
        callID: "C1",
        args: { filePath: "x.ts" },
      },
      { title: "read", output: "content", metadata: {} },
    );

    loaded.capture.context.messages = [
      {
        role: "user",
        content:
          "We finished the alpha build switch. Remember that alpha builds are run with make all " +
          "from the repository root directory. Also the staging API rate limit is 120 requests " +
          "per minute per key as of October 2026, which matters for the batch importer.",
      },
    ];
    loaded.capture.generate.response = JSON.stringify([
      { type: "pattern", scope: "build", content: DUP_CONTENT }, // exact dupe of the seeded row
      { type: "learning", scope: "api", content: FRESH_CONTENT }, // genuinely new
    ]);

    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-cap" },
    });
    await waitFor(
      () =>
        evidence().some((l) => l.ev === "auto_capture_collapsed") &&
        evidence().some((l) => l.ev === "auto_capture_promoted"),
    );

    // Exactly ONE new active memory, the fresh one, tagged auto-capture.
    const mems = (await loadAll()).filter(isActive);
    const captured = mems.filter((m) => m.tags?.includes("auto-capture"));
    expect(captured.length).toBe(1);
    expect(captured[0].content).toBe(FRESH_CONTENT);
    // The dupe did NOT write a second row (gate collapsed it, not capture).
    expect(mems.filter((m) => m.content === DUP_CONTENT).length).toBe(1);

    // Evidence: one collapsed line naming the session, one promoted line.
    const collapsed = evidence().filter(
      (l) => l.ev === "auto_capture_collapsed",
    );
    expect(collapsed.length).toBe(1);
    expect(String(collapsed[0].session)).toBe("ses-cap");
    expect(
      evidence().filter((l) => l.ev === "auto_capture_promoted").length,
    ).toBe(1);

    // The model call carried the parsed model ref and the capture prompt.
    expect(loaded.capture.generate.calls.length).toBe(1);
    expect(loaded.capture.generate.calls[0].model).toEqual({
      providerID: "fake",
      id: "model",
    });
    expect(loaded.capture.generate.calls[0].prompt).toContain("JSON array");

    // Cooldown: a second idle for the same session (well within 5 minutes)
    // must not trigger another context read or model call.
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-cap" },
    });
    await sleep(100);
    expect(loaded.capture.generate.calls.length).toBe(1);
    expect(loaded.capture.context.calls.length).toBe(1);

    await loaded.cleanup();
  });

  test("a credential-shaped captured scope is blocked and never reaches evidence", async () => {
    const key = "sk-" + "proj-ZyXwVu9876543210ZyXwVu9876543210abc";
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    loaded.capture.context.messages = [
      {
        role: "user",
        content:
          "The durable public detail is that releases run from the repository root. ".repeat(
            4,
          ),
      },
    ];
    loaded.capture.generate.response = JSON.stringify([
      {
        type: "context",
        scope: `OPENAI_API_KEY=${key}`,
        content: "releases run from the repository root",
        status: "open",
      },
    ]);

    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-scope-secret" },
    });
    await waitFor(() =>
      evidence().some((l) => l.ev === "auto_capture_blocked"),
    );

    const blocked = evidence().find((l) => l.ev === "auto_capture_blocked");
    expect(String(blocked?.reason)).toBe("credential_in_metadata");
    expect(
      (await loadAll()).some((m) => m.tags?.includes("auto-capture")),
    ).toBe(false);
    const evidenceText = readFileSync(
      join(evidenceDir(), `${dateStr()}.logfmt`),
      "utf8",
    );
    expect(evidenceText).not.toContain(key);

    await loaded.cleanup();
  });

  test("secrets and reasoning never reach the model, and returned secrets are redacted", async () => {
    const key = "sk-" + "proj-AbCdEf0123456789AbCdEf0123456789xyz";
    const reasoning = "INTERNAL_REASONING_SENTINEL should remain private";
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    loaded.capture.context.messages = [
      {
        info: { role: "user" },
        parts: [
          {
            type: "text",
            text:
              `The deployment is complete. OPENAI_API_KEY=${key}. ` +
              "The durable public detail is that releases run from the repository root. ".repeat(
                3,
              ),
          },
          { type: "reasoning", text: reasoning },
        ],
      },
    ];
    loaded.capture.generate.response = JSON.stringify([
      {
        type: "context",
        scope: "env",
        content: `The OpenAI key for this project is OPENAI_API_KEY=${key}`,
        status: "open",
      },
    ]);

    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-secret" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    await waitFor(() =>
      evidence().some((l) => l.ev === "auto_capture_promoted"),
    );

    const prompt = loaded.capture.generate.calls[0].prompt;
    expect(prompt).not.toContain(key);
    expect(prompt).not.toContain(reasoning);
    expect(prompt).toContain("[redacted]");

    const captured = (await loadAll()).find((m) =>
      m.tags?.includes("auto-capture"),
    );
    expect(captured?.content).toContain("[redacted]");
    expect(captured?.content).not.toContain(key);

    const manual = await loaded.tool.memory_remember.execute({
      type: "learning",
      scope: "manual-credentials",
      content: `The manual deployment credential is SERVICE_TOKEN=${key}`,
      status: "open",
    });
    expect(manual).toBe("Remembered: learning in manual-credentials");
    const store = readFileSync(
      join(memoryRoot(), `${dateStr()}.logfmt`),
      "utf8",
    );
    expect(store).not.toContain(key);
    expect(store.match(/\[redacted\]/g)?.length).toBe(2);
    await loaded.cleanup();
  });

  test("setup cleanup aborts the subscription; later events are not processed", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    expect(loaded.capture.events.signals.length).toBe(2); // measured + capture
    expect(loaded.capture.events.signals.every((s) => !s.aborted)).toBe(true);

    await loaded.cleanup();
    expect(loaded.capture.events.signals.every((s) => s.aborted)).toBe(true);

    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-post" },
    });
    await sleep(50);
    expect(loaded.capture.context.calls.length).toBe(0);
    expect(loaded.capture.generate.calls.length).toBe(0);
  });
});

// ---- trigger vocabulary (#136) --------------------------------------------
// Auto-capture waited for `session.idle`: declared by the protocol, never
// emitted by the host, so the feature was dead everywhere on 2.x with no warning
// anywhere. These pin the vocabulary to what a live host actually sends (see
// test/fixtures/host-events.jsonl) and keep the invented name from creeping
// back in.
describe("turn-end trigger vocabulary (#136)", () => {
  const armed = { autoCapture: true, captureModel: "fake/model" };

  async function modelCallsAfter(
    event: Record<string, unknown>,
  ): Promise<number> {
    const loaded = await loadCapturePlugin(armed);
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push(event);
    await sleep(120);
    const calls = loaded.capture.generate.calls.length;
    await loaded.cleanup();
    return calls;
  }

  test("session.execution.succeeded fires the capture model", async () => {
    expect(
      await modelCallsAfter({
        type: "session.execution.succeeded",
        data: { sessionID: "ses-t1" },
      }),
    ).toBe(1);
  });

  test("session.execution.interrupted fires too — the context is ending either way", async () => {
    expect(
      await modelCallsAfter({
        type: "session.execution.interrupted",
        data: { sessionID: "ses-t2" },
      }),
    ).toBe(1);
  });

  test("declared-but-never-emitted events do NOT fire: `session.status`", async () => {
    // The protocol declares it; a live host was never observed sending it
    // (150 s over a turn plus 80 s quiet). Supporting it would be #136 again.
    expect(
      await modelCallsAfter({
        type: "session.status",
        data: { sessionID: "ses-t3", status: { type: "idle" } },
      }),
    ).toBe(0);
  });

  test("declared-but-never-emitted events do NOT fire: `session.idle`", async () => {
    expect(
      await modelCallsAfter({
        type: "session.idle",
        data: { sessionID: "ses-legacy" },
      }),
    ).toBe(0);
    expect(
      await modelCallsAfter({ type: "session.idle", sessionID: "ses-legacy2" }),
    ).toBe(0);
  });

  test("`session.execution.failed` does not capture (declared, not reproduced)", async () => {
    const loaded = await loadCapturePlugin(armed);
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.events.push({
      type: "session.execution.failed",
      data: { sessionID: "ses-fail" },
    });
    await sleep(120);
    expect(loaded.capture.generate.calls.length).toBe(0);
    expect((await loadAll()).length).toBe(0);
    await loaded.cleanup();
  });
});

// ---- capture model inheritance (#139) ---------------------------------------
// Requiring captureModel alongside autoCapture was a syntax tax: the opt-in is
// autoCapture:true, the host already delivers the session's model on every
// session hook (SessionRequest.model), and the tax's failure mode was a silent
// disable. These pin the inheritance chain — explicit option, then the ref the
// session.context hook carried, then the host default, and only then a skip —
// plus model= on the capture evidence lines so cost is attributable.
describe("capture model inheritance (#139)", () => {
  test("no captureModel: capture fires with the ref the session.context hook carried", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true });
    // Red on main: an omitted captureModel disabled the whole subscription,
    // so subscribeCalls stayed 1 (measured listener only).
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    await loaded["experimental.chat.system.transform"](
      {
        sessionID: "ses-inherit",
        model: { providerID: "fake", id: "session-model" },
      },
      { system: [] },
    );
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-inherit" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    expect(loaded.capture.generate.calls[0].model).toEqual({
      providerID: "fake",
      id: "session-model",
    });
    await loaded.cleanup();
  });

  test("no session ref recorded: the host default model is used", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.modelDefault = {
      providerID: "host",
      modelID: "default-model",
    };
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-default" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    expect(loaded.capture.generate.calls[0].model).toEqual({
      providerID: "host",
      id: "default-model",
    });
    await loaded.cleanup();
  });

  test("neither session ref nor host default: skip with reason=no_model, no tokens spent", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-nomodel" },
    });
    await waitFor(() =>
      evidence().some(
        (l) => l.ev === "auto_capture_refused" && l.reason === "no_model",
      ),
    );
    expect(loaded.capture.generate.calls.length).toBe(0);
    expect(loaded.capture.context.calls.length).toBe(0);
    await loaded.cleanup();
  });

  test("an explicit captureModel still wins over the session's model", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "explicit/model",
    });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    await loaded["experimental.chat.system.transform"](
      {
        sessionID: "ses-explicit",
        model: { providerID: "fake", id: "session-model" },
      },
      { system: [] },
    );
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = "[]";
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-explicit" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    expect(loaded.capture.generate.calls[0].model).toEqual({
      providerID: "explicit",
      id: "model",
    });
    await loaded.cleanup();
  });

  test("capture evidence lines carry model= for the model that ran", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    // Ground the session so the gate promotes the candidate (see the dupe test).
    await loaded["tool.execute.after"](
      {
        tool: "read",
        sessionID: "ses-modeltag",
        callID: "C1",
        args: { filePath: "x.ts" },
      },
      { title: "read", output: "content", metadata: {} },
    );
    await loaded["experimental.chat.system.transform"](
      {
        sessionID: "ses-modeltag",
        model: { providerID: "fake", id: "session-model" },
      },
      { system: [] },
    );
    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.generate.response = JSON.stringify([
      {
        type: "learning",
        scope: "capture",
        content:
          "Evidence lines name the model that produced the candidate row.",
      },
    ]);
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-modeltag" },
    });
    // Session-scoped wait on the LAST line the capture pass appends: the
    // evidence log is shared across this file, and the old unscoped match on
    // auto_capture_promoted could be satisfied by an earlier test's promoted
    // line before THIS capture's trailing capture_lag line had been appended —
    // the race that turned CI red at c9193f9 (the lag lookup then saw no
    // line, model=undefined). capture_lag is written after every candidate
    // line of its pass (src/capture/runtime.ts), so waiting for this session's
    // lag line orders both lookups, and the session filter strengthens the
    // promoted assertion too.
    await waitFor(() =>
      evidence().some(
        (l) => l.ev === "capture_lag" && l.session === "ses-modeltag",
      ),
    );
    const promoted = evidence().find(
      (l) => l.ev === "auto_capture_promoted" && l.session === "ses-modeltag",
    );
    expect(String(promoted?.model)).toBe("fake/session-model");
    const lag = evidence().find(
      (l) => l.ev === "capture_lag" && l.session === "ses-modeltag",
    );
    expect(String(lag?.model)).toBe("fake/session-model");
    await loaded.cleanup();
  });
});

// ---- startup heartbeat (#138) ----------------------------------------------
// Every other evidence line is written BY something that already worked, so
// "off", "misconfigured" and "armed but inert" looked identical from any
// artifact a user can read — the reason a pipeline that had never run survived a
// review and a merge. These pin that the load line distinguishes them.
describe("plugin_load heartbeat (#138)", () => {
  const heartbeat = () =>
    evidence()
      .filter((e) => e.ev === "plugin_load")
      .pop();

  test("default options: capture=off, and the subscribed vocabulary is visible", async () => {
    const loaded = await loadCapturePlugin({});
    const line = heartbeat();
    expect(line?.capture).toBe("off");
    expect(String(line?.subscribed)).toContain("session.execution.succeeded");
    expect(typeof line?.version).toBe("string");
    await loaded.cleanup();
  });

  test("armed with a bad model: capture=invalid_model, not silence", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "no-slash-model",
    });
    expect(heartbeat()?.capture).toBe("invalid_model");
    await loaded.cleanup();
  });

  test("armed correctly: capture=on with all three capabilities present", async () => {
    const loaded = await loadCapturePlugin({
      autoCapture: true,
      captureModel: "fake/model",
    });
    const line = heartbeat();
    expect(line?.capture).toBe("on");
    expect(String(line?.capabilities)).toBe(
      "[event.subscribe,generate.text,session.context]",
    );
    await loaded.cleanup();
  });

  test("armed with NO captureModel: capture=on, the inherited-model arm (#139)", async () => {
    // Omitted is a valid arm now: the capture inherits per session. Only an
    // explicit malformed string is invalid_model (the test above).
    const loaded = await loadCapturePlugin({ autoCapture: true });
    expect(heartbeat()?.capture).toBe("on");
    await loaded.cleanup();
  });

  test("switch mismatch: captureOnCompact alone is NOT plain off (#138)", async () => {
    // captureOnCompact:true with autoCapture absent warns at setup and does
    // nothing. The evidence file must name that state, or "off (default)" and
    // "user set the wrong switch" stay one line.
    const loaded = await loadCapturePlugin({ captureOnCompact: true });
    expect(heartbeat()?.capture).toBe("switch_mismatch");
    await loaded.cleanup();
  });
});

// ---- swallowed hook failures (#138) -----------------------------------------
// guarded() is fail-soft by design, but a plugin failing EVERY turn looked
// identical to a healthy one in every artifact: the console.warn lands in the
// host log, which the user never reads. setup() installs an evidence-backed
// reporter so the swallowed failure reaches the same file as the heartbeat —
// hook name + error class only, never the message (a hook payload can carry
// conversation content).
describe("hook_error evidence (#138)", () => {
  test("a guarded failure lands in the evidence file as hook_error, class only", async () => {
    const loaded = await loadCapturePlugin({});
    await guarded("demo-hook", async () => {
      throw new TypeError("boom: secret transcript fragment");
    });
    const line = evidence()
      .filter((e) => e.ev === "hook_error")
      .pop();
    expect(line?.hook).toBe("demo-hook");
    expect(line?.error).toBe("TypeError");
    // Never the message: content must not reach the durable log.
    expect(
      evidence().some((l) =>
        Object.values(l).some((v) => String(v).includes("secret transcript")),
      ),
    ).toBe(false);
    await loaded.cleanup();
  });

  test("a non-Error throw still records, with typeof as the class", async () => {
    const loaded = await loadCapturePlugin({});
    await guarded("string-throw-hook", async () => {
      throw "plain string";
    });
    const line = evidence()
      .filter((e) => e.ev === "hook_error")
      .pop();
    expect(line?.hook).toBe("string-throw-hook");
    expect(line?.error).toBe("string");
    await loaded.cleanup();
  });
});
