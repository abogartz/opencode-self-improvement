// Contract (#128): a recognized credential in ordinary tool output never
// persists in durable evidence and never rides back into the model through
// memory_evidence — with auto-capture OFF (the default configuration this
// leaked in) or ON. The scrub lives at the write boundaries: record() scrubs
// every string field, and afterTool redacts the COMPLETE tool text BEFORE
// summarize() folds/truncates, so a token cannot survive as a prefix fragment
// past the 80-char cut and PEM END markers cannot be cut off before matching.
// Audit reasons (deletions.logfmt) carry the same rule. Fixing NEW writes says
// nothing about old files — remediation stays separate (#74).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { rememberSessionDir, resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { resetState, setCurrent } from "../src/core/state.ts";
import { deletionsFile, evidenceDir } from "../src/core/config/paths.ts"
import { dateStr } from "../src/core/time.ts";
import { redactSecrets } from "../src/store/secrets.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { pruneMemory } from "../src/store/prune.ts";

const TOKEN = "ghp_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "TUlJRVp4SUJBQUtDQVFFQWZha2UtYm9keS1saW5lLWZvci10aGUtcmVkYWN0aW9uLXRlc3Q=",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

let root: string;
let a: string;
let plugin: LoadedPlugin | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-sec128-"));
  a = join(root, "repo-a");
  mkdirSync(a);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  resetCaptureCooldowns();
  setRepoScope(resolveRepo(a));
  // ses-a IS a session OF repo-a — bound, not module-scope-borrowed (#127).
  rememberSessionDir("ses-a", a);
  setCurrent({ sessionID: "ses-a" });
});

afterEach(async () => {
  await plugin?.cleanup();
  plugin = undefined;
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const evidenceText = (): string => {
  try {
    return readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8");
  } catch {
    return "";
  }
};

async function driveToolResult(output: string, options?: Record<string, unknown>): Promise<LoadedPlugin> {
  plugin = await loadPlugin(a, options);
  await plugin.toolHooks["execute.after"]({
    sessionID: "ses-a",
    callID: "read1",
    tool: "read",
    input: { filePath: ".env" },
    result: { content: output },
  });
  return plugin;
}

test("a recognized credential in tool output never reaches evidence or memory_evidence (auto-capture off)", async () => {
  expect(redactSecrets(TOKEN)).toBe("[redacted]"); // the scrub knows this shape
  const p = await driveToolResult(`GITHUB_TOKEN=${TOKEN}`);

  const raw = evidenceText();
  expect(raw).toContain("tool_result"); // the line WAS written — telemetry survives
  expect(raw).not.toContain(TOKEN);
  expect(raw).toContain("[redacted]");

  const returned = await p.tools.memory_evidence.execute({ ev: "tool_result" });
  expect(returned.content).not.toContain(TOKEN);
});

test("the same holds with auto-capture on", async () => {
  await driveToolResult(`leaked ${TOKEN} in config dump`, {
    autoCapture: true,
    captureModel: "fake/model",
  });
  expect(evidenceText()).not.toContain(TOKEN);
});

test("a credential crossing the 80-char summary boundary leaves no prefix fragment", async () => {
  // The old summarize-first path kept chars 0..79, slicing the token at its
  // 12th character — a PREFIX redactSecrets never sees as a whole token and
  // appendLog happily stored. Redaction now runs on the complete text first.
  const padding = "a".repeat(70);
  await driveToolResult(`${padding}TOK=${TOKEN} rest`);
  const raw = evidenceText();
  expect(raw).not.toContain("ghp_"); // no fragment of the token survives
  expect(raw).toContain("[redac"); // (the scrub's marker may itself sit at the 80-char cut)
});

test("multiline private-key material is scrubbed whole, not folded into fragments", async () => {
  await driveToolResult(`cat deploy.pem\n${PEM}\n(done)`);
  const raw = evidenceText();
  expect(raw).not.toContain("PRIVATE KEY");
  expect(raw).not.toContain("TUlJRVp4SUJBQUtDQVFFQWZh"); // no body line survives
  expect(raw).toContain("[redacted]");
});

test("deletion audit records scrub a credential carried in the reason", async () => {
  // The audit/reason family is the same write-boundary class (#128): a human
  // reason like "rotated ghp_..." must not persist the secret verbatim.
  const ts = await appendMemory({ type: "context", scope: "secrets-audit", content: "note" });
  const res = await pruneMemory("secrets-audit", "context", `rotated ${TOKEN}`, "ses-a");
  expect(res.deleted.length).toBe(1);
  const audit = readFileSync(deletionsFile(), "utf8");
  expect(audit).toContain(ts); // the audit line itself is intact
  expect(audit).not.toContain(TOKEN);
  expect(audit).toContain("[redacted]");
});
