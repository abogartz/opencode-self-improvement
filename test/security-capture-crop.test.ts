// Contract (#132, 2026-10-26 security review, medium): auto-capture redacts
// BEFORE it crops. captureSession used to mine `transcript.slice(-8000)` and
// let buildCapturePrompt scrub the WINDOW — but a credential straddling the
// crop boundary arrives as a fragment: a PEM body with its BEGIN marker
// cropped away matches no pattern (the regex needs both markers), and a token
// without its prefix is invisible to the prefix families. The fix scrubs the
// COMPLETE transcript first, then applies the character budget. The proof is
// the prompt actually handed to the capture model.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flattenTranscript } from "../src/capture/transcript.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { resetState } from "../src/core/state.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";

let root: string;
let plugin: LoadedPlugin | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "osi-sec132-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  resetCaptureCooldowns();
  setRepoScope(null);
  // One quiet row: the compaction hook's anchor path reads the store before
  // the capture seam fires, exactly like the compaction-capture suite.
  await appendMemory({
    type: "context",
    scope: "general",
    content: "the nightly archive job keeps fourteen days of tarballs",
    status: "settled",
    repo: "global",
  });
});

afterEach(async () => {
  await plugin?.cleanup();
  plugin = undefined;
  resetState();
  resetSessionScopes();
  resetCaptureCooldowns();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

async function capturePromptFor(sid: string, messages: unknown): Promise<string> {
  plugin = await loadPlugin(root, { autoCapture: true, captureModel: "fake/model" });
  plugin.capture.generate.response = "[]";
  await plugin.sessionHooks.compaction?.({ sessionID: sid, system: [], messages });
  await waitFor(() => plugin!.capture.generate.calls.length === 1);
  return plugin.capture.generate.calls[0]!.prompt;
}

// The crop window must genuinely straddle the credential: these guards read
// the SAME flattenTranscript output the capture path mines, so they hold on
// any revision — the behavioral assertions below are the red/green signal.
function cropStart(flat: string): number {
  const start = Math.max(0, flat.length - 8000);
  expect(flat.length).toBeGreaterThan(8000);
  return start;
}

const BODY_ALPHA = "aB3dE5fG7hIjKlZxCvBnQwErTyUiOp";
const PEM_BODY_MARKER = "Zk9BxRnMq7TwYeUiO";

function pemBody(len: number, marker: string, at: number): string {
  let s = "";
  while (s.length < len) s += BODY_ALPHA;
  s = s.slice(0, len);
  return s.slice(0, at) + marker + s.slice(at + marker.length);
}

test("a PEM body straddling the crop boundary never reaches the capture model", async () => {
  const body = pemBody(8300, PEM_BODY_MARKER, 3500);
  const messages = [
    { role: "user", content: "Can you check this key rotation output for me?" },
    {
      role: "assistant",
      content:
        "-----BEGIN PRIVATE KEY-----\n" +
        body +
        "\n-----END PRIVATE KEY-----\nThat was the pasted rotation key. The deploy ran twice afterwards.",
    },
  ];
  const flat = flattenTranscript(messages);
  const start = cropStart(flat);
  // The probe only counts if BEGIN fell OUT of the window and the body did not.
  expect(start).toBeGreaterThan(flat.indexOf("-----BEGIN PRIVATE KEY") + 10);
  expect(start).toBeLessThan(flat.indexOf(PEM_BODY_MARKER));

  const prompt = await capturePromptFor("ses-crop-pem", messages);
  // On the reviewed revision this prompt carried key-body fragments and the
  // END marker; the scrub could not see what the crop had already beheaded.
  expect(prompt).not.toContain(PEM_BODY_MARKER);
  expect(prompt).not.toContain("-----END PRIVATE KEY-----");
  expect(prompt).not.toContain("-----BEGIN");
  // And the mine still ran: the harmless tail rode the window.
  expect(prompt).toContain("deploy ran twice");
});

test("a token whose prefix falls out of the crop is still redacted", async () => {
  const TOKEN = "ghp_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AB";
  const messages = [
    {
      role: "assistant",
      content:
        TOKEN +
        " was pasted while debugging auth. " +
        "z".repeat(7913) +
        " End of the debug transcript.",
    },
  ];
  const flat = flattenTranscript(messages);
  const start = cropStart(flat);
  const tokStart = flat.indexOf("ghp_");
  // Crop starts INSIDE the token: prefix gone (no prefix match possible),
  // secret tail still in the window.
  expect(tokStart).toBeGreaterThan(0);
  expect(start).toBeGreaterThan(tokStart + 4);
  expect(start).toBeLessThan(tokStart + TOKEN.length - 8);
  const fragment = flat.slice(start, tokStart + TOKEN.length);
  expect(fragment.length).toBeGreaterThan(8);

  const prompt = await capturePromptFor("ses-crop-token", messages);
  expect(prompt).not.toContain(fragment);
  expect(prompt).not.toContain("ghp_");
  expect(prompt).toContain("debug transcript");
});
