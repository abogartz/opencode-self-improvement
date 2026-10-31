// Contract: serve-host session identity, replaying payload shapes RECORDED
// from a real `opencode serve --service` (host 2.1.4, issue #90) — captured
// by a probe plugin observing the same stream the plugin sees:
//   - session.created is never delivered: the service loads the plugin AFTER
//     the session exists.
//   - session.execution.started carries ONLY the sessionID:
//       {"type":"session.execution.started","durable":{...},
//        "data":{"sessionID":"ses_…"}}
//   - session context messages carry NO location field (user/assistant rows
//     with id/time/text/content only).
//   - the session ROW (session.get) does carry location.directory.
// The unit fakes in repo-scope-session.test.ts feed the shapes the plugin
// HOPES for; this file pins it to what the host SENDS: identity must resolve
// through the session row before the first write, exactly once per session.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoScopeFor, resetSessionScopes, resolveRepo, sessionScope, setRepoScope } from "../src/repokey.ts";
import { loadPlugin } from "./harness.ts";
import moveRecording from "./fixtures/host-session-move.json";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-servehost-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetSessionScopes();
});
afterEach(() => {
  setRepoScope(null);
  resetSessionScopes();
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true });
});

const dayFile = () => join(process.env.OPENCODE_MEMORY_DIR!, `${new Date().toISOString().split("T")[0]}.logfmt`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

// Plain dirs key by hash of the normalized path (#92); the session row still
// supplies the PATH, which the scope machinery resolves through this.
const keyOf = (d: string) => resolveRepo(d).key;

// Recorded serve-mode event: identity WITHOUT any location payload.
const executionStarted = (sid: string) => ({
  id: "evt_rec0rded0001",
  created: 1792879840331,
  type: "session.execution.started",
  durable: { aggregateID: sid, seq: 2, version: 1 },
  data: { sessionID: sid },
});

describe("serve-host replay: recorded 2.2.2 session move (#176)", () => {
  test("rebinds to data.location, not the old outer location, before the next write", async () => {
    const from = join(root, "move-from");
    const to = join(root, "move-to");
    mkdirSync(from);
    mkdirSync(to);
    const recorded = moveRecording.events[0];
    expect(recorded.type).toBe("session.moved");
    expect(recorded.location.directory).not.toBe(recorded.data.location.directory);
    const sid = recorded.data.sessionID;
    const loaded = await loadPlugin(from);
    try {
      // Establish the original binding through the existing API fallback.
      loaded.capture.session.row = { id: sid, location: { directory: from } };
      loaded.capture.events.push(executionStarted(sid));
      await waitFor(() => sessionScope(sid)?.path === from);
      const lookups = loaded.capture.session.getCalls.length;

      // Replay the captured shape with only its path placeholders relocated to
      // this test's disposable directories. The fallback row deliberately stays A.
      loaded.capture.events.push({
        ...recorded,
        location: { ...recorded.location, directory: from },
        data: { ...recorded.data, location: { ...recorded.data.location, directory: to } },
      });
      await waitFor(() => sessionScope(sid)?.path === to);
      expect(loaded.capture.session.getCalls.length).toBe(lookups);
      const out = await writeOne(loaded, sid, "recorded workspace move destination fact");
      expect(out.content).toContain("Remembered");
      const raw = readFileSync(dayFile(), "utf8");
      expect(raw).toContain(`repo=${keyOf(to)}`);
      expect(raw).toContain(`repoPath=${to}`);
      expect(raw).not.toContain(`repo=${keyOf(from)}`);
    } finally {
      await loaded.cleanup();
    }
  });
});

// Recorded serve-mode context messages: no `location` on any row.
const locationlessMessages = [
  { id: "msg_user0001", time: { created: 1792879840340 }, text: "hello", type: "user" },
  {
    id: "msg_assistant0001",
    time: { created: 1792879840363, streamed: 1792879840378, completed: 1792879840378 },
    type: "assistant",
    agent: "build",
    model: { id: "scripted", providerID: "fake" },
    content: [{ type: "text", text: "hi" }],
    finish: "stop",
  },
];

async function writeOne(loaded: Awaited<ReturnType<typeof loadPlugin>>, sid: string, content: string) {
  await loaded["tool.execute.before"]({ sessionID: sid, callID: "c1", tool: "memory_remember" });
  return loaded.tools["memory_remember"].execute(
    { type: "context", scope: "serve-replay", status: "open", content },
    {},
  );
}

describe("serve-host replay: execution.started carries no location", () => {
  test("identity resolves from the session row before the first write", async () => {
    const serveRoot = join(root, "serviceLaunchDir"); // where `serve --service` runs
    const sessionRepo = join(root, "sessionRepo"); // the session's real workspace
    mkdirSync(serveRoot, { recursive: true });
    mkdirSync(sessionRepo, { recursive: true });

    const loaded = await loadPlugin(serveRoot); // module scope = service launch dir
    try {
      loaded.capture.context.messages = locationlessMessages; // legacy fallback finds nothing
      loaded.capture.session.row = { id: "ses_rec0rded", location: { directory: sessionRepo } };

      loaded.capture.events.push(executionStarted("ses_rec0rded"));
      await waitFor(() => repoScopeFor("ses_rec0rded")?.path === sessionRepo);

      const out = await writeOne(loaded, "ses_rec0rded", `replayed serve fact ${Date.now()}`);
      expect(out.content).toContain("Remembered");
      const raw = readFileSync(dayFile(), "utf8");
      expect(raw).toContain(`repo=${keyOf(sessionRepo)}`);
      expect(raw).toContain(`repoPath=${sessionRepo}`);
      expect(raw).not.toContain(serveRoot); // the #90 signature must not appear
      expect(raw).not.toContain(`repo=${keyOf(serveRoot)}`); // nor its hashed key
    } finally {
      await loaded.cleanup();
    }
  });

  test("the session row is consulted once per session, not every turn", async () => {
    const serveRoot = join(root, "serviceLaunchDir2");
    const sessionRepo = join(root, "sessionRepo2");
    mkdirSync(serveRoot, { recursive: true });
    mkdirSync(sessionRepo, { recursive: true });

    const loaded = await loadPlugin(serveRoot);
    try {
      loaded.capture.context.messages = locationlessMessages;
      loaded.capture.session.row = { id: "ses_once", location: { directory: sessionRepo } };

      loaded.capture.events.push(executionStarted("ses_once"));
      await waitFor(() => repoScopeFor("ses_once")?.path === sessionRepo);
      // A second and third turn: already bound, no new lookups.
      loaded.capture.events.push(executionStarted("ses_once"));
      loaded.capture.events.push(executionStarted("ses_once"));
      await sleep(30);
      expect(loaded.capture.session.getCalls.filter((s) => s === "ses_once").length).toBe(1);
    } finally {
      await loaded.cleanup();
    }
  });

  test("a host whose session.get yields nothing stays unbound and never throws", async () => {
    const serveRoot = join(root, "serviceLaunchDir3");
    mkdirSync(serveRoot, { recursive: true });

    const loaded = await loadPlugin(serveRoot);
    try {
      loaded.capture.context.messages = locationlessMessages;
      loaded.capture.session.row = undefined; // host cannot resolve the row

      loaded.capture.events.push(executionStarted("ses_orphan"));
      await sleep(30);
      const out = await writeOne(loaded, "ses_orphan", `degraded fallback fact ${Date.now()}`);
      expect(out.content).toContain("Remembered");
      // Degraded behavior pinned: with no session identity anywhere, the write
      // lands in the MODULE scope (the documented fallback), not unscoped.
      const raw = readFileSync(dayFile(), "utf8");
      expect(raw).toContain(`repo=${keyOf(serveRoot)}`);
    } finally {
      await loaded.cleanup();
    }
  });

  test("events that DO carry a location bind directly, without a row lookup", async () => {
    const serveRoot = join(root, "serviceLaunchDir4");
    const sessionRepo = join(root, "sessionRepo4");
    mkdirSync(serveRoot, { recursive: true });
    mkdirSync(sessionRepo, { recursive: true });

    const loaded = await loadPlugin(serveRoot);
    try {
      loaded.capture.session.row = { id: "ses_direct", location: { directory: sessionRepo } };
      // Standalone-mode shape (recorded): session.created with location.
      loaded.capture.events.push({
        id: "evt_rec0rded0000",
        created: 1792879422500,
        type: "session.created",
        location: { directory: sessionRepo },
        data: { sessionID: "ses_direct", location: { directory: sessionRepo } },
      });
      await waitFor(() => repoScopeFor("ses_direct")?.path === sessionRepo);
      expect(loaded.capture.session.getCalls.length).toBe(0);
    } finally {
      await loaded.cleanup();
    }
  });
});
