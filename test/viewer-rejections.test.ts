// #222: viewer writes are trusted admin edits, but do not silently withdraw a
// value rejection. Exercise the real HTTP endpoints against an isolated store.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletionsFile, snapshotDir } from "../src/core/config/paths.ts";
import { resetState } from "../src/core/state.ts";
import { contentHash } from "../src/evidence/record.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { loadAll, memoryFiles } from "../src/store/files/load.ts";
import { prune } from "../src/store/files/prune.ts";
import { redactSecrets } from "../src/store/secrets.ts";
import { rejectedFile } from "../src/store/tombstones/rejection.ts";
import { tombstone } from "../src/store/tombstones/tombstone.ts";
import { editMemory } from "../src/viewer/mutate.ts";
import { startViewer, type ViewerServer } from "../src/viewer/server.ts";
import { removeStore } from "./helpers/remove-store.ts";

const REJECTED =
  "decided to adopt the express framework for the http layer and terminate tls at the load balancer";
const REWORDED =
  "the http layer adopts express, with tls terminated at the load balancer";
const UNRELATED =
  "the image pipeline resizes uploads to 2048 pixels before writing them to object storage";
const ORIGINAL =
  "maintain the rendering pipeline release checklist beside its integration fixtures";

let root: string;
let viewer: ViewerServer;
let oldMemoryDir: string | undefined;
let oldCommandsDir: string | undefined;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "osi222-"));
  oldMemoryDir = process.env.OPENCODE_MEMORY_DIR;
  oldCommandsDir = process.env.OPENCODE_COMMANDS_DIR;
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  viewer = await startViewer(0);
});
afterEach(() => {
  viewer.server.stop(true);
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  if (oldMemoryDir === undefined) delete process.env.OPENCODE_MEMORY_DIR;
  else process.env.OPENCODE_MEMORY_DIR = oldMemoryDir;
  if (oldCommandsDir === undefined) delete process.env.OPENCODE_COMMANDS_DIR;
  else process.env.OPENCODE_COMMANDS_DIR = oldCommandsDir;
  removeStore(root);
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, viewer.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routes = ["/api/edit", "/api/restore-entry"];

async function writeBody(content: string) {
  const ts = await appendMemory({
    type: "learning",
    scope: "viewer",
    content: ORIGINAL,
    repo: "repo-owner",
    repoPath: "/projects/owner",
    tags: ["import"],
    kw: ["render"],
    issue: "#222",
  });
  return {
    ts,
    type: "learning",
    scope: "viewer",
    content,
    reason: "human correction",
    repo: "repo-owner",
    repoPath: "/projects/owner",
  };
}

async function durableState() {
  const files = await memoryFiles();
  return {
    memories: files.map((file) => [file, readFileSync(file, "utf8")]),
    snapshots: existsSync(snapshotDir())
      ? readdirSync(snapshotDir()).sort()
      : [],
    audit: existsSync(deletionsFile())
      ? readFileSync(deletionsFile(), "utf8")
      : null,
    rejections: readFileSync(rejectedFile(), "utf8"),
  };
}

describe.each(routes)("viewer rejection boundary: %s", (route) => {
  test.each([REJECTED, REWORDED])(
    "refuses a rejected value without changing memory, snapshots, audit or rejection: %s",
    async (content) => {
      const body = await writeBody(content);
      // Rejection is independent of row id and scope; use the real block route.
      const rejectedTs = await appendMemory({
        type: "decision",
        scope: "http",
        content: REJECTED,
      });
      expect(
        (
          await post("/api/block", {
            ts: rejectedTs,
            reason: "rejected by operator",
          })
        ).status,
      ).toBe(200);
      const before = await durableState();
      const response = await post(route, body);
      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result.error).toContain("previously_rejected");
      expect(result.error).toContain(contentHash(REJECTED));
      expect(result.error).toContain("un-reject");
      expect(result.error).not.toContain(REJECTED);
      expect(await durableState()).toEqual(before);
    },
  );

  test("replaying a forgotten value stays refused after its original row is gone", async () => {
    await appendMemory({ type: "decision", scope: "http", content: REJECTED });
    expect(
      (await prune("http", "decision", "forget the wrong decision")).deleted,
    ).toHaveLength(1);
    const body = await writeBody(REJECTED);
    const before = await durableState();
    expect((await post(route, body)).status).toBe(400);
    expect(await durableState()).toEqual(before);
  });

  test("explicit un-reject permits retry while preserving the original edit metadata", async () => {
    const body = await writeBody(REJECTED);
    await tombstone(REJECTED, { reason: "wrong", source: "forget" });
    expect((await post(route, body)).status).toBe(400);
    const released = await post("/api/unreject", { ch: contentHash(REJECTED) });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ unrejected: true });
    const response = await post(route, body);
    expect(response.status).toBe(200);
    const result = await response.json();
    const ts = route === "/api/edit" ? result.superseded_by : result.restored;
    const rows = await loadAll();
    const stored = rows.find((m) => m.ts === ts);
    expect(stored?.content).toBe(REJECTED);
    expect(stored?.repo).toBe("repo-owner");
    expect(stored?.repoPath).toBe("/projects/owner");
    if (route === "/api/edit") {
      expect(stored?.tags).toEqual(["import"]);
      expect(stored?.kw).toEqual(["render"]);
      expect(stored?.issue).toBe("#222");
      expect(rows.find((m) => m.ts === body.ts)?.superseded_by).toBe(ts);
      expect(result.snapshot).toBeTruthy();
      expect(readFileSync(deletionsFile(), "utf8")).toContain("action=edited");
    }
  });

  test.each([
    [REJECTED, UNRELATED],
    [
      "the retention policy keeps the deployment logs for 30 days",
      "the retention policy keeps the deployment logs for 90 days",
    ],
    [
      "the service must enable anonymous access for the public status endpoint",
      "the service must not enable anonymous access for the public status endpoint",
    ],
  ])(
    "allows a different claim or corrected value: %s -> %s",
    async (rejected, content) => {
      const body = await writeBody(content);
      await tombstone(rejected, { reason: "wrong", source: "forget" });
      const response = await post(route, body);
      expect(response.status).toBe(200);
      const result = await response.json();
      const ts = route === "/api/edit" ? result.superseded_by : result.restored;
      expect((await loadAll()).find((m) => m.ts === ts)?.content).toBe(content);
      expect(readFileSync(rejectedFile(), "utf8")).toContain(
        contentHash(rejected),
      );
    },
  );

  test("checks the redacted bytes that appendMemory will persist", async () => {
    // Short prose keeps near-match out of the decision; normalization must
    // catch the exact rejected hash after the existing secret scrub.
    const content = `token ghp_${"A".repeat(36)}`;
    const body = await writeBody(content);
    await tombstone(redactSecrets(content), {
      reason: "reject this scrubbed value",
      source: "forget",
    });
    const before = await durableState();
    expect((await post(route, body)).status).toBe(400);
    expect(await durableState()).toEqual(before);
  });

  test("an unreadable rejection ledger refuses the write instead of granting it", async () => {
    const body = await writeBody(UNRELATED);
    const files = await memoryFiles();
    const before = files.map((file) => readFileSync(file, "utf8"));
    // A directory at the ledger path makes reads fail on both Windows and
    // POSIX without mocks, privilege assumptions or a timing race.
    mkdirSync(rejectedFile());
    expect((await post(route, body)).status).toBe(400);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
    expect(existsSync(snapshotDir())).toBe(false);
    expect(existsSync(deletionsFile())).toBe(false);
  });
});

test("direct editMemory callers cannot bypass the same rejection check", async () => {
  const body = await writeBody(REJECTED);
  await tombstone(REJECTED, { reason: "wrong", source: "forget" });
  const before = await durableState();
  await expect(editMemory(body)).rejects.toThrow("previously_rejected");
  expect(await durableState()).toEqual(before);
});
