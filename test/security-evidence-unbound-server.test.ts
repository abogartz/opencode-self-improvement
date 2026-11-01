// Follow-up re-review on #133 (posted after the first three probes passed):
// fresh evidence written for a session whose repository CANNOT be resolved —
// the server-style plugin with no setup location — leaked two ways. (1) The
// line carried `sid=` but no repo stamp, and "no stamp" read as global
// (the legacy-admin semantics), so any other session's memory_evidence
// returned it. (2) record()'s `repoScopeFor(sid)` module fallback stamped
// the line with whoever loaded LAST, so a second instance's correctly
// scoped reads legitimately returned it. Both are #127's "unknown is never
// everything" rule, one boundary late: identity may be unknown, ALL is
// never the fallback for a NAMED session. Explicit `repo=global` lines and
// genuinely sid-less lines (legacy, out-of-plugin maintenance) keep their
// historical global reading — that policy is untouched.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { rememberSessionDir, resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { evidenceDir } from "../src/core/config/paths.ts"
import { dateStr } from "../src/core/time.ts";

let root: string;
let b: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-evidserv-"));
  b = join(root, "repo-b");
  mkdirSync(b);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  resetCaptureCooldowns();
  setRepoScope(null);
  plugins = [];
});

afterEach(async () => {
  for (const p of plugins) await p.cleanup();
  plugins = [];
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("osi-evidserv-")) {
    throw new Error("Unexpected fixture cleanup path");
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// Probe 1: server-style plugin (NO setup directory), nothing to provisionally
// bind to. A's tool_result is written for a named-but-unresolved session;
// bound session B must not receive it. The line still names A (audit keeps
// its sid) — what it must lose is the global visibility of a missing stamp.
test("new evidence from an unresolved server session is not global to other sessions", async () => {
  const p = await loadPlugin(null);
  plugins = [p];
  await p.toolHooks["execute.after"]?.({
    sessionID: "ses-unresolved-a",
    id: "read-a",
    tool: "read",
    input: {},
    result: { content: "UNRESOLVED_A_CONFIDENTIAL_RESULT" },
  });
  const raw = readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8");
  expect(raw).toContain("sid=ses-unresolved-a"); // the audit identity it DID name
  expect(raw).toContain("UNRESOLVED_A_CONFIDENTIAL_RESULT"); // evidence still lands — data, not injected

  rememberSessionDir("ses-b", b);
  const res = await p.tools.memory_evidence.execute(
    { ev: "tool_result" },
    { sessionID: "ses-b", id: "evidence-b" },
  );
  const out = String((res as { content?: string }).content ?? "");
  expect(out).not.toContain("UNRESOLVED_A_CONFIDENTIAL_RESULT");
  // And A itself still reads its own line — private to the session, not lost.
  const own = await p.tools.memory_evidence.execute(
    { ev: "tool_result" },
    { sessionID: "ses-unresolved-a", id: "evidence-a" },
  );
  expect(String((own as { content?: string }).content ?? "")).toContain("UNRESOLVED_A_CONFIDENTIAL_RESULT");
});

// Probe 2: the scope-less plugin loads FIRST, a repository-B plugin loads
// after it (so the shared module scope is B's). A's evidence must not borrow
// that stamp — a later instance's repository is not A's data's home.
test("unresolved server-session evidence never borrows another instance's repo stamp", async () => {
  const pa = await loadPlugin(null);
  const pb = await loadPlugin(b);
  plugins = [pa, pb];
  rememberSessionDir("ses-b", b);
  await pa.toolHooks["execute.after"]?.({
    sessionID: "ses-unresolved-a",
    id: "read-a",
    tool: "read",
    input: {},
    result: { content: "UNRESOLVED_A_WRONG_REPO_RESULT" },
  });
  const raw = readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8");
  expect(raw).toContain("sid=ses-unresolved-a");
  // A's OWN line must not carry B's repo stamp. Scan A's line, not the whole
  // file: instance B's own boot records (session-less writes) legitimately
  // stamp B's repository, and they share the day file — the reviewers'
  // smoking-gun line is the one that carries A's marker.
  const aLine = raw.split("\n").find((l) => l.includes("UNRESOLVED_A_WRONG_REPO_RESULT"));
  expect(aLine).toBeDefined();
  expect(aLine).not.toContain(`repo=${resolveRepo(b).key}`);
  const res = await pb.tools.memory_evidence.execute(
    { ev: "tool_result" },
    { sessionID: "ses-b", id: "evidence-b" },
  );
  const out = String((res as { content?: string }).content ?? "");
  expect(out).not.toContain("UNRESOLVED_A_WRONG_REPO_RESULT");
});
