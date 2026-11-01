// Contract (#129): the viewer is an explicit ADMIN entry point — it may LIST
// every repository, but a mutation it performs must never WIDEN a row's
// visibility. The standalone viewer process has no repository scope, and an
// edit that let appendMemory resolve the stamp from that null scope turned a
// repo-private row into an unstamped (=> global) row: a typo fix made private
// customer data recallable and injectable in every project. Origin (repo
// stamp), provenance (issue/tags) and retrieval aliases (kw) survive an edit;
// the delete audit line carries the origin so the restore-entry round trip
// restores the row's ORIGINAL visibility. Going global stays a deliberate act.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemory } from "../src/store/files/append.ts"
import { loadAll } from "../src/store/files/load.ts"
import { type Memory } from "../src/store/model/memory.ts"
import { isActive } from "../src/store/model/predicates.ts"
import { isVisibleHere } from "../src/store/model/visibility.ts";
import { resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { deletionsFile } from "../src/core/config/paths.ts";
import { startViewer, type ViewerServer } from "../src/viewer/server.ts";

let root: string;
let a: string;
let b: string;
let viewer: ViewerServer | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-sec129-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  setRepoScope(null); // the standalone viewer process has no repo scope
});

afterEach(async () => {
  viewer?.server.stop(true);
  viewer = undefined;
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function startAdminViewer(): Promise<ViewerServer> {
  if (!viewer) viewer = await startViewer(0);
  return viewer;
}

async function post(v: ViewerServer, route: string, body: Record<string, unknown>): Promise<Response> {
  return v.server.fetch(
    new Request(new URL(route, v.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const visibleActive = async (): Promise<Memory[]> =>
  (await loadAll()).filter(isActive).filter(isVisibleHere);

test("editing a repo-private row in the viewer keeps it private to its origin repo", async () => {
  const scopeA = resolveRepo(a);
  const scopeB = resolveRepo(b);
  const ts = await appendMemory({
    type: "context",
    scope: "customer",
    content: "Private customer migration schedule.",
    repo: scopeA.key,
    repoPath: scopeA.path,
  });

  setRepoScope(scopeB);
  expect(await visibleActive()).toHaveLength(0); // private to A: invisible in B

  setRepoScope(null); // the viewer process: admin read, NO repo scope of its own
  const v = await startAdminViewer();
  const res = await post(v, "/api/edit", {
    ts,
    type: "context",
    scope: "customer",
    content: "Private customer migration schedule, corrected.",
    reason: "Correct typo",
  });
  expect(res.status).toBe(200);

  // The typo fix must NOT have promoted the row to global.
  setRepoScope(scopeB);
  expect(await visibleActive()).toHaveLength(0);

  // And in its own repo the edited row is what reads — with its origin intact.
  setRepoScope(scopeA);
  const inA = await visibleActive();
  expect(inA).toHaveLength(1);
  expect(inA[0].content).toContain("corrected");
  expect(inA[0].repo).toBe(scopeA.key);
  expect(inA[0].repoPath).toBe(scopeA.path);
});

test("an edit that omits provenance preserves issue, tags and keywords from the target", async () => {
  const scopeA = resolveRepo(a);
  const ts = await appendMemory({
    type: "pattern",
    scope: "build",
    content: "Use bun run gate before merging.",
    issue: "PR-42",
    tags: ["import"],
    kw: ["gate", "merge check"],
    repo: scopeA.key,
    repoPath: scopeA.path,
  });

  const v = await startAdminViewer();
  // The usual UI sends ONLY type/scope/content/reason (#129: the old path
  // erased provenance and aliases exactly this way).
  const res = await post(v, "/api/edit", {
    ts,
    type: "pattern",
    scope: "build",
    content: "Use bun run gate before merging, from a clean tree.",
    reason: "Clarify",
  });
  expect(res.status).toBe(200);

  setRepoScope(scopeA);
  const rows = await visibleActive();
  expect(rows).toHaveLength(1);
  expect(rows[0].issue).toBe("PR-42");
  expect(rows[0].tags).toEqual(["import"]);
  expect(rows[0].kw).toEqual(["gate", "merge check"]);
});

test("delete audit keeps the origin, and restore-entry restores the ORIGINAL visibility", async () => {
  const scopeA = resolveRepo(a);
  const scopeB = resolveRepo(b);
  const ts = await appendMemory({
    type: "context",
    scope: "customer",
    content: "Deleted-but-private row.",
    repo: scopeA.key,
    repoPath: scopeA.path,
  });

  const v = await startAdminViewer();
  const del = await post(v, "/api/delete", { ts, reason: "duplicate" });
  expect(del.status).toBe(200);

  // The audit line carries the origin, so the UI (and this test) can replay it.
  const audit = readFileSync(deletionsFile(), "utf8");
  expect(audit).toContain(ts);
  expect(audit).toContain(`repo=${scopeA.key}`);

  const restored = await post(v, "/api/restore-entry", {
    type: "context",
    scope: "customer",
    content: "Deleted-but-private row.",
    repo: scopeA.key,
    repoPath: scopeA.path,
  });
  expect(restored.status).toBe(200);

  setRepoScope(scopeB);
  expect(await visibleActive()).toHaveLength(0); // still A's row, not a global row
  setRepoScope(scopeA);
  const inA = await visibleActive();
  expect(inA).toHaveLength(1);
  expect(inA[0].repo).toBe(scopeA.key);
});

test("editing a legacy unstamped row leaves it global — and now says so on the row", async () => {
  // No stamp on the target means legacy/explicit-global: the replacement lands
  // with the SAME visibility (global), stated honestly as repo=global rather
  // than left ambiguous by the viewer's missing scope.
  const ts = await appendMemory({ type: "preference", scope: "style", content: "Prefer tabs." });
  const v = await startAdminViewer();
  const res = await post(v, "/api/edit", {
    ts,
    type: "preference",
    scope: "style",
    content: "Prefer tabs, width 2.",
    reason: "Detail",
  });
  expect(res.status).toBe(200);

  setRepoScope(resolveRepo(b));
  const inB = await visibleActive();
  expect(inB).toHaveLength(1);
  expect(inB[0].repo).toBe("global");
});
