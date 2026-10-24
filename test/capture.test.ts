// Contract: opt-in auto-capture on session idle.
//
// Unit tests for the pure core (parseCandidates / parseModelRef / buildCapturePrompt
// / flattenTranscript — all total functions) plus end-to-end runs through the
// harness fake event queue proving: default OFF never subscribes; an invalid
// captureModel skips registration; candidates flow through runWriteGate (the
// dupe collapses, only the fresh one lands, tagged auto-capture); the 5-minute
// per-session cooldown bounds model calls; and setup's cleanup aborts the
// subscription. Hermetic: temp OPENCODE_MEMORY_DIR / OPENCODE_COMMANDS_DIR.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dateStr, evidenceDir, memoryRoot } from "../src/config.ts";
import { formatLine, parseLine, type Fields } from "../src/logfmt.ts";
import { resetState } from "../src/state.ts";
import { isActive, loadAll } from "../src/memory.ts";
import { setRepoScope } from "../src/repokey.ts";
import { loadPlugin } from "./harness.ts";
import {
  buildCapturePrompt,
  flattenTranscript,
  parseCandidates,
  parseModelRef,
} from "../src/capture.ts";

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
    expect(parseCandidates(`Sure! ${JSON.stringify([GOOD])} — enjoy`, 3)).toEqual([GOOD]);
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
    expect(parseCandidates("[1, \"x\", null, [2]]", 3)).toEqual([]);
    expect(parseCandidates(JSON.stringify([{ ...GOOD, type: "wisdom" }]), 3)).toEqual([]);
    expect(parseCandidates(JSON.stringify([{ type: GOOD.type, content: GOOD.content }]), 3)).toEqual([]);
    expect(parseCandidates(JSON.stringify([{ type: GOOD.type, scope: GOOD.scope }]), 3)).toEqual([]);
    expect(parseCandidates(JSON.stringify([{ ...GOOD, scope: "  " }]), 3)).toEqual([]);
  });

  test("control characters in structured fields are dropped", () => {
    expect(parseCandidates(JSON.stringify([{ ...GOOD, scope: "build\n## SYSTEM" }]), 3)).toEqual([]);
    expect(parseCandidates(JSON.stringify([{ ...GOOD, scope: "build\u2028forged" }]), 3)).toEqual([]);
    expect(parseCandidates(JSON.stringify([{ ...GOOD, type: "learning\r" }]), 3)).toEqual([]);
  });

  test("content outside 20-600 chars is dropped at the exact boundaries", () => {
    expect(parseCandidates(JSON.stringify([{ ...GOOD, content: "x".repeat(19) }]), 3)).toEqual([]);
    expect(parseCandidates(JSON.stringify([{ ...GOOD, content: "x".repeat(20) }]), 3).length).toBe(1);
    expect(parseCandidates(JSON.stringify([{ ...GOOD, content: "x".repeat(600) }]), 3).length).toBe(1);
    expect(parseCandidates(JSON.stringify([{ ...GOOD, content: "x".repeat(601) }]), 3)).toEqual([]);
  });

  test("status passes through only for open/settled; anything else becomes undefined", () => {
    const open = parseCandidates(JSON.stringify([{ ...GOOD, status: "open" }]), 3);
    expect(open[0].status).toBe("open");
    const junk = parseCandidates(JSON.stringify([{ ...GOOD, status: "pending" }]), 3);
    expect(junk[0].status).toBeUndefined();
  });

  test("clamps to max; max <= 0 yields []", () => {
    const three = [GOOD, { ...GOOD, content: "A second durable fact about the build pipeline." }, { ...GOOD, content: "A third durable fact worth keeping around." }];
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
    for (const t of ["decision", "learning", "preference", "blocker", "context", "pattern"]) {
      expect(p).toContain(t);
    }
    expect(p).toContain("hello world");
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
      "-----BEGIN " + "PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
    ];
    const ordinary = [
      "const API_TOKEN = resolveTokenName;",
      "API_KEY=process.env.OPENAI_API_KEY",
      "the Bearer authentication-scheme-description",
    ];
    const p = buildCapturePrompt(`user: ${secrets.join("\n")}\n${ordinary.join("\n")}`, 3);
    for (const secret of secrets) expect(p).not.toContain(secret);
    expect(p).toContain("[redacted]");
    for (const line of ordinary) expect(p).toContain(line);
  });
});

describe("flattenTranscript", () => {
  test("renders role: text from info.role+parts and role+content; skips junk", () => {
    const msgs = [
      { info: { role: "user" }, parts: [{ text: "do the thing" }, { type: "file" }, { text: "please" }] },
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

  test("non-arrays yield \"\" and the cap is 40 user turns", () => {
    expect(flattenTranscript("nope")).toBe("");
    expect(flattenTranscript(null)).toBe("");
    const many = Array.from({ length: 45 }, (_, i) => ({
      role: "user",
      content: `turn ${i} with enough text to be counted`,
    }));
    const out = flattenTranscript(many);
    expect(out.split("\n").filter((l) => l.startsWith("user:")).length).toBe(40);
  });
});

// --- end-to-end through the harness fake event queue ----------------------------

const DUP_CONTENT = "Alpha builds are run with make all from the repository root directory.";
const FRESH_CONTENT = "The staging API rate limit is 120 requests per minute per key as of October 2026.";

async function loadCapturePlugin(options: Record<string, unknown>) {
  return loadPlugin(liveRoot, options);
}

describe("auto-capture end-to-end (session.idle -> gate)", () => {
  test("default options: only the zero-model measured listener subscribes", async () => {
    const loaded = await loadCapturePlugin({});
    // The measured-usage listener subscribes by default (no model calls);
    // auto-capture itself never does.
    expect(loaded.capture.events.subscribeCalls).toBe(1);
    loaded.capture.events.push({ type: "session.idle", sessionID: "ses-off" });
    await sleep(50);
    expect(loaded.capture.generate.calls.length).toBe(0);
    expect(loaded.capture.context.calls.length).toBe(0);
  });

  test("autoCapture on but invalid captureModel: capture subscription is not registered", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true, captureModel: "no-slash-model" });
    expect(loaded.capture.events.subscribeCalls).toBe(1); // measured listener only
  });

  test("non-idle events are ignored", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true, captureModel: "fake/model" });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    loaded.capture.events.push({ type: "session.updated", sessionID: "ses-x" });
    await sleep(50);
    expect(loaded.capture.context.calls.length).toBe(0);
    await loaded.cleanup();
  });

  test("thin transcript: session.context runs but the model is not called", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true, captureModel: "fake/model" });
    loaded.capture.context.messages = [{ role: "user", content: "too short to mine" }];
    loaded.capture.events.push({ type: "session.idle", sessionID: "ses-thin" });
    await waitFor(() => loaded.capture.context.calls.length === 1);
    await sleep(50);
    expect(loaded.capture.generate.calls.length).toBe(0);
    await loaded.cleanup();
  });

  test("2.x data envelope calls the capture model and writes evidence", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true, captureModel: "fake/model" });
    await loaded["tool.execute.after"](
      { tool: "read", sessionID: "ses-data", callID: "C1", args: { filePath: "x.ts" } },
      { title: "read", output: "content", metadata: {} },
    );
    loaded.capture.context.messages = [{ role: "user", content: "x".repeat(300) }];
    loaded.capture.generate.response = JSON.stringify([
      {
        type: "learning",
        scope: "capture",
        content: "OpenCode 2.x session idle events carry their session identifier under data.",
      },
    ]);

    loaded.capture.events.push({ type: "session.idle", data: { sessionID: "ses-data" } });
    await waitFor(() => evidence().some((l) => String(l.ev).startsWith("auto_capture_")));

    expect(loaded.capture.generate.calls.length).toBe(1);
    expect(loaded.capture.context.calls).toEqual(["ses-data"]);
    expect(evidence().some((l) => String(l.ev).startsWith("auto_capture_") && l.session === "ses-data")).toBe(
      true,
    );
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
      { tool: "read", sessionID: "ses-cap", callID: "C1", args: { filePath: "x.ts" } },
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

    loaded.capture.events.push({ type: "session.idle", sessionID: "ses-cap" });
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
    const collapsed = evidence().filter((l) => l.ev === "auto_capture_collapsed");
    expect(collapsed.length).toBe(1);
    expect(String(collapsed[0].session)).toBe("ses-cap");
    expect(evidence().filter((l) => l.ev === "auto_capture_promoted").length).toBe(1);

    // The model call carried the parsed model ref and the capture prompt.
    expect(loaded.capture.generate.calls.length).toBe(1);
    expect(loaded.capture.generate.calls[0].model).toEqual({ providerID: "fake", id: "model" });
    expect(loaded.capture.generate.calls[0].prompt).toContain("JSON array");

    // Cooldown: a second idle for the same session (well within 5 minutes)
    // must not trigger another context read or model call.
    loaded.capture.events.push({ type: "session.idle", sessionID: "ses-cap" });
    await sleep(100);
    expect(loaded.capture.generate.calls.length).toBe(1);
    expect(loaded.capture.context.calls.length).toBe(1);

    await loaded.cleanup();
  });

  test("a credential-shaped captured scope is blocked and never reaches evidence", async () => {
    const key = "sk-" + "proj-ZyXwVu9876543210ZyXwVu9876543210abc";
    const loaded = await loadCapturePlugin({ autoCapture: true, captureModel: "fake/model" });
    loaded.capture.context.messages = [
      {
        role: "user",
        content: "The durable public detail is that releases run from the repository root. ".repeat(4),
      },
    ];
    loaded.capture.generate.response = JSON.stringify([
      { type: "context", scope: `OPENAI_API_KEY=${key}`, content: "releases run from the repository root", status: "open" },
    ]);

    loaded.capture.events.push({ type: "session.idle", sessionID: "ses-scope-secret" });
    await waitFor(() => evidence().some((l) => l.ev === "auto_capture_blocked"));

    const blocked = evidence().find((l) => l.ev === "auto_capture_blocked");
    expect(String(blocked?.reason)).toBe("credential_in_metadata");
    expect((await loadAll()).some((m) => m.tags?.includes("auto-capture"))).toBe(false);
    const evidenceText = readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8");
    expect(evidenceText).not.toContain(key);

    await loaded.cleanup();
  });

  test("secrets and reasoning never reach the model, and returned secrets are redacted", async () => {
    const key = "sk-" + "proj-AbCdEf0123456789AbCdEf0123456789xyz";
    const reasoning = "INTERNAL_REASONING_SENTINEL should remain private";
    const loaded = await loadCapturePlugin({ autoCapture: true, captureModel: "fake/model" });
    loaded.capture.context.messages = [
      {
        info: { role: "user" },
        parts: [
          {
            type: "text",
            text:
              `The deployment is complete. OPENAI_API_KEY=${key}. ` +
              "The durable public detail is that releases run from the repository root. ".repeat(3),
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

    loaded.capture.events.push({ type: "session.idle", sessionID: "ses-secret" });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    await waitFor(() => evidence().some((l) => l.ev === "auto_capture_promoted"));

    const prompt = loaded.capture.generate.calls[0].prompt;
    expect(prompt).not.toContain(key);
    expect(prompt).not.toContain(reasoning);
    expect(prompt).toContain("[redacted]");

    const captured = (await loadAll()).find((m) => m.tags?.includes("auto-capture"));
    expect(captured?.content).toContain("[redacted]");
    expect(captured?.content).not.toContain(key);

    const manual = await loaded.tool.memory_remember.execute({
      type: "learning",
      scope: "manual-credentials",
      content: `The manual deployment credential is SERVICE_TOKEN=${key}`,
      status: "open",
    });
    expect(manual).toBe("Remembered: learning in manual-credentials");
    const store = readFileSync(join(memoryRoot(), `${dateStr()}.logfmt`), "utf8");
    expect(store).not.toContain(key);
    expect(store.match(/\[redacted\]/g)?.length).toBe(2);
    await loaded.cleanup();
  });

  test("setup cleanup aborts the subscription; later events are not processed", async () => {
    const loaded = await loadCapturePlugin({ autoCapture: true, captureModel: "fake/model" });
    await waitFor(() => loaded.capture.events.subscribeCalls === 2);
    expect(loaded.capture.events.signals.length).toBe(2); // measured + capture
    expect(loaded.capture.events.signals.every((s) => !s.aborted)).toBe(true);

    await loaded.cleanup();
    expect(loaded.capture.events.signals.every((s) => s.aborted)).toBe(true);

    loaded.capture.context.messages = [
      { role: "user", content: "x".repeat(300) },
    ];
    loaded.capture.events.push({ type: "session.idle", sessionID: "ses-post" });
    await sleep(50);
    expect(loaded.capture.context.calls.length).toBe(0);
    expect(loaded.capture.generate.calls.length).toBe(0);
  });
});
