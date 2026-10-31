// Contract: capture's repo stamp is resolved from the session CAPTURED, not from
// whichever session happened to call setCurrent last (issue #116).
//
// captureSession binds `setCurrent({ sessionID: sid })` and then AWAITS — context
// re-reads and, decisively, the generate.text model call. A server hosts many
// sessions: between the binding and the persistence, any other session's tool
// call or idle fire moves the module-global current, and appendMemory's choke
// point (repoScopeFor(getCurrent().sid)) then stamps the row with the WRONG
// session's repo. The row is only findable from the other workspace: a silent
// cross-repo leak of one project's facts into another's memory.
//
// Red shape (deterministic, no sleeps): the parked model stub parks INSIDE the
// capture's await; the test then runs another session's setCurrent and releases.
// The capture's persistence happens strictly after the hijack, so the unfixed
// write path necessarily sees the other session.
// Hermetic: temp OPENCODE_MEMORY_DIR; two dirs bound as distinct repo scopes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dateStr, evidenceDir, memoryRoot } from "../src/config.ts";
import { runWriteGate } from "../src/gates.ts";
import { parseLine, type Fields } from "../src/logfmt.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { rememberSessionDir, repoScopeFor, resetSessionScopes, setRepoScope } from "../src/repokey.ts";
import { resetState, setCurrent } from "../src/state.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";

let root: string;
let liveRoot: string;
let otherRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-capture-sid-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
  resetSessionScopes(); // bySession is module state shared across test files
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo-a");
  mkdirSync(liveRoot, { recursive: true });
  otherRoot = join(root, "repo-b");
  mkdirSync(otherRoot, { recursive: true });
  resetState();
  resetCaptureCooldowns();
});

afterEach(() => {
  // Mirror the setup above. `bySession` and the current session are module state
  // shared with every other test file in this process, and repoScopeFor() prefers
  // a session entry over the ambient scope: leaving "ses-other" mapped to
  // <tmp>/repo-b silently re-stamps the NEXT file's writes, so whichever file
  // happens to run after this one fails with someone else's repo key. The sibling
  // test/repo-scope-session.test.ts already tears down the same way.
  setRepoScope(null);
  resetSessionScopes();
  resetState();
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function evidence(): Fields[] {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => parseLine(l))
      .filter((f): f is Fields => f !== null);
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

function rows(): Fields[] {
  const file = join(memoryRoot(), `${dateStr()}.logfmt`);
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => parseLine(l))
      .filter((f): f is Fields => f !== null);
  } catch {
    return [];
  }
}

async function driveCompaction(loaded: LoadedPlugin, sessionID: string, messages: unknown): Promise<void> {
  await loaded.sessionHooks["compaction"]?.({ sessionID, system: [], messages });
}

// Ground the CAPTURING session so the candidate promotes (same seam as the
// compaction tests) — engagement is per-session on purpose.
async function ground(loaded: LoadedPlugin, sessionID: string): Promise<void> {
  await loaded["tool.execute.after"](
    { tool: "read", sessionID, callID: "C1", args: { filePath: "x.ts" } },
    { title: "read", output: "content", metadata: {} },
  );
}

const FRESH_CONTENT = "The staging API rate limit is 120 requests per minute per key as of October 2026.";

function thickMessages(): unknown[] {
  return [
    {
      role: "user",
      content:
        "Also the staging API rate limit is 120 requests per minute per key as of October 2026, " +
        "which matters for the batch importer we wire next sprint, and remember it applies per key.",
    },
    {
      role: "assistant",
      content: "Understood: the staging rate limit is 120 requests per minute per key, respected in the importer.",
    },
  ];
}

describe("capture repo stamp follows the captured session (#116)", () => {
  test("another session's setCurrent during the capture's model await cannot hijack the stamp", async () => {
    // Two workspaces, two sessions: the plugin loaded for repo A; repo B's
    // session exists in the server too (a second setup/workspace binds it).
    rememberSessionDir("ses-capture", liveRoot);
    rememberSessionDir("ses-other", otherRoot);

    const loaded = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    await ground(loaded, "ses-capture");
    let release!: () => void;
    loaded.capture.generate.park = new Promise<void>((r) => {
      release = r;
    });
    loaded.capture.generate.response = JSON.stringify([{ type: "pattern", scope: "api", content: FRESH_CONTENT }]);

    await driveCompaction(loaded, "ses-capture", thickMessages());
    await waitFor(() => loaded.capture.generate.calls.length === 1); // parked INSIDE the await
    // The capture is mid-model-call. Another session of another workspace now
    // does anything that moves the global current (a tool call, an idle fire).
    setCurrent({ sessionID: "ses-other" });
    release();

    // Wait for the capture to FINISH (either verdict), then judge what it left.
    await waitFor(() => evidence().some((e) => String(e.ev ?? "").startsWith("auto_capture_compaction_")));
    const captured = rows().find((r) => String(r.content ?? "").includes("staging API rate limit"));
    const a = repoScopeFor("ses-capture");
    const b = repoScopeFor("ses-other");
    expect(a?.key).not.toBe(b?.key); // the two workspaces really are distinct scopes
    // RED on main, in whichever shape the interleaving lands: blocked outright
    // (the gate evaluated ses-other's empty evidence — captured is undefined)
    // or promoted carrying B's stamp. Both violate the contract: a fact mined
    // from repo A's transcript must land as repo A's memory, and only that.
    expect(captured).toBeDefined();
    expect(captured!.repo).toBe(a?.key);
    expect(captured!.repo).not.toBe(b?.key);
    // The paper-trail half of the same contract (#118 review note 1): the row
    // is the durable memory, but the gate's evidence lines are what an
    // operator greps first — and every one of them is appended AFTER the
    // hijack, so on ambient-read code their sid= field carries ses-other.
    // They must name the session the gate ran FOR, chain-consistently.
    const promoted = evidence().find((e) => e.ev === "write_promoted");
    expect(promoted).toBeDefined();
    expect(promoted!.sid).toBe("ses-capture");
    for (const e of evidence()) {
      if (e.chain === promoted!.chain && typeof e.sid === "string") {
        expect(e.sid).toBe("ses-capture");
      }
    }
  });

  test("control: a capture with no competing session stamps its own repo", async () => {
    rememberSessionDir("ses-capture", liveRoot);
    const loaded = await loadPlugin(liveRoot, { autoCapture: true, captureModel: "fake/model" });
    await ground(loaded, "ses-capture");
    loaded.capture.generate.response = JSON.stringify([{ type: "pattern", scope: "api", content: FRESH_CONTENT }]);
    await driveCompaction(loaded, "ses-capture", thickMessages());
    // Wait on the verdict record, not the row: the row lands a beat BEFORE the
    // outcome evidence line is appended, and reading evidence in that window is
    // a test-induced race, not a plugin bug.
    await waitFor(() => evidence().some((e) => String(e.ev ?? "").startsWith("auto_capture_compaction_")));
    expect(rows().find((r) => String(r.content ?? "").includes("staging API rate limit"))!.repo).toBe(
      repoScopeFor("ses-capture")?.key,
    );
    expect(evidence().some((e) => String(e.ev ?? "").startsWith("auto_capture_compaction_"))).toBe(true);
    // This is the no-interleave control: captureSession itself binds setCurrent,
    // so ambient-read code can pass this assertion by coincidence. The hijack
    // cases above establish that the session survives an actual interleave.
    expect(evidence().find((e) => e.ev === "write_promoted")!.sid).toBe("ses-capture");
  });

  test("a BLOCKED gate write names the ctx session in its audit lines, ambient be damned", async () => {
    // The recBlocked arm of the same threading, at the direct gate seam (the
    // one #118's kill-verification used): by the time a hijacked capture's
    // gate appends write_blocked, the ambient current IS the hijacker — so
    // poisoning it directly stands in for the interleave, hitting every line
    // runWriteGate writes. Ungrounded + refs 0 blocks as ambiguous_memory.
    rememberSessionDir("ses-capture", liveRoot);
    rememberSessionDir("ses-other", otherRoot);
    setCurrent({ sessionID: "ses-other" });
    const out = await runWriteGate(
      { type: "learning", scope: "engine", content: "engine uses the clp logger, not winston" },
      { liveRoot, evidenceCalls: [], hasGateCheck: false, sessionID: "ses-capture" },
    );
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("ambiguous_memory");
    const wb = evidence().find((e) => e.ev === "write_blocked");
    expect(wb).toBeDefined();
    expect(wb!.sid).toBe("ses-capture"); // the gate ran FOR ses-capture
    for (const e of evidence()) {
      if (e.chain === wb!.chain && typeof e.sid === "string") {
        expect(e.sid).toBe("ses-capture");
      }
    }
  });
});
