// #305 (decision #212 A): viewer-originated evidence inherits the TARGET
// ROW's repository. The viewer is an admin entry point with no repository of
// its own, and its record() calls used to emit unstamped lines — which
// evidenceVisibleTo reads as GLOBAL. So editing or deleting another
// repository's private row from the viewer broadcast the operator's reason
// and row ids to every other repository's memory_evidence. GREEN: the line
// carries the target's stamp and is invisible to a stranger repo, visible to
// the target's repo and to the admin reader; an edit of a `repo=global` row
// still reads as global.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import {
  rememberSessionDir,
  resetSessionScopes,
  resolveRepo,
  setRepoScope,
} from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { evidenceDir, memoryRoot } from "../src/core/config/paths.ts";
import { dateStr } from "../src/core/time.ts";
import { formatLine, parseLine } from "../src/core/logfmt/format.ts";
import { editMemory, releaseQuarantinedMemory } from "../src/viewer/mutate.ts";
import { addBlock } from "../src/store/blocklist.ts";
import { removeStore } from "./helpers/remove-store.ts";
import {
  ADMIN_READER,
  evidenceVisibleTo,
} from "../src/store/model/visibility.ts";

let root: string;
let a: string;
let b: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-viewrepo-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  resetCaptureCooldowns();
  // Viewer-shaped process: no ambient repository, no session.
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
  removeStore(root);
});

function seed(
  ts: string,
  repo?: string,
  repoPath?: string,
  tags?: string,
): void {
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    formatLine({
      ts,
      type: "learning",
      scope: "auth",
      content: `seeded row (${repo ?? "unstamped"})`,
      repo,
      repoPath,
      tags,
    }) + "\n",
  );
}

function evidenceLines(evName: string): Record<string, unknown>[] {
  return readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8")
    .trim()
    .split("\n")
    .map(parseLine)
    .filter((l): l is Record<string, unknown> => !!l && l.ev === evName);
}

test("viewer edit of a repo-B row is invisible to a repo-A memory_evidence, visible to B and admin (#305)", async () => {
  const scopeA = resolveRepo(a);
  const scopeB = resolveRepo(b);
  const T1 = "2026-01-05T00:00:00.000Z";
  seed(T1, scopeB.key, scopeB.path);
  // The viewer's own route handler calls editMemory directly; no session, no
  // repository scope — exactly the viewer-shaped process the defect lived in.
  await editMemory({
    ts: T1,
    type: "learning",
    scope: "auth",
    content: "edited row content",
    reason: "REPO_B_EDIT_REASON_305",
  });

  const line = evidenceLines("viewer_edit").find((f) =>
    String(f.reason).includes("REPO_B_EDIT_REASON_305"),
  );
  expect(line).toBeDefined();
  // The line must carry B's stamp. On main it is unstamped, which
  // evidenceVisibleTo below reads as global — RED for exactly the defect.
  expect(line!.repo).toBe(scopeB.key);
  expect(line!.repoPath).toBe(scopeB.path);
  expect(
    evidenceVisibleTo(line!, { kind: "repo", scope: scopeA }, "ses-a"),
  ).toBe(false);
  expect(
    evidenceVisibleTo(line!, { kind: "repo", scope: scopeB }, "ses-b"),
  ).toBe(true);
  expect(evidenceVisibleTo(line!, ADMIN_READER)).toBe(true);

  // Tool level: the real memory_evidence read path, repo-A session.
  const pa = await loadPlugin(a);
  const pb = await loadPlugin(b);
  plugins = [pa, pb];
  rememberSessionDir("ses-a", a);
  rememberSessionDir("ses-b", b);
  const resA = await pa.tools.memory_evidence.execute(
    { ev: "viewer_edit" },
    { sessionID: "ses-a", id: "evidence-a" },
  );
  expect(String((resA as { content?: string }).content ?? "")).not.toContain(
    "REPO_B_EDIT_REASON_305",
  );
  // B still reads its own audit trail — privacy, not loss.
  const resB = await pb.tools.memory_evidence.execute(
    { ev: "viewer_edit" },
    { sessionID: "ses-b", id: "evidence-b" },
  );
  expect(String((resB as { content?: string }).content ?? "")).toContain(
    "REPO_B_EDIT_REASON_305",
  );
});

test("viewer edit of a repo=global row still yields a globally visible line (#305)", async () => {
  const scopeA = resolveRepo(a);
  const T1 = "2026-01-05T00:00:00.000Z";
  seed(T1, "global");
  await editMemory({
    ts: T1,
    type: "learning",
    scope: "auth",
    content: "edited global row",
    reason: "GLOBAL_EDIT_REASON_305",
  });
  const line = evidenceLines("viewer_edit").find((f) =>
    String(f.reason).includes("GLOBAL_EDIT_REASON_305"),
  );
  expect(line).toBeDefined();
  expect(line!.repo).toBe("global");
  expect(
    evidenceVisibleTo(line!, { kind: "repo", scope: scopeA }, "ses-a"),
  ).toBe(true);
  const pa = await loadPlugin(a);
  plugins = [pa];
  rememberSessionDir("ses-a", a);
  const res = await pa.tools.memory_evidence.execute(
    { ev: "viewer_edit" },
    { sessionID: "ses-a", id: "evidence-a" },
  );
  expect(String((res as { content?: string }).content ?? "")).toContain(
    "GLOBAL_EDIT_REASON_305",
  );
});

// F1 on #308: a BLOCKLISTED private row is hidden from loadAll(), but
// releaseQuarantine scans the raw day files and releases it anyway. The origin
// lookup must be unfiltered too, or the quarantine_released line falls back to
// unstamped/global and the operator's reason leaks to every other repository's
// memory_evidence — the residual of the very defect #305 fixes.
test("release of a BLOCKLISTED repo-B row stamps its evidence with B, not global (#308 F1)", async () => {
  const scopeA = resolveRepo(a);
  const scopeB = resolveRepo(b);
  const T1 = "2026-01-05T00:00:00.000Z";
  seed(T1, scopeB.key, scopeB.path, "quarantine");
  await addBlock(T1, "blocked before release");

  const result = await releaseQuarantinedMemory(
    T1,
    "BLOCKED_PRIVATE_REASON_308",
  );
  expect(result.released).toBe(true);

  const line = evidenceLines("quarantine_released").find((f) =>
    String(f.reason).includes("BLOCKED_PRIVATE_REASON_308"),
  );
  expect(line).toBeDefined();
  expect(line!.repo).toBe(scopeB.key);
  expect(line!.repoPath).toBe(scopeB.path);
  expect(
    evidenceVisibleTo(line!, { kind: "repo", scope: scopeA }, "ses-a"),
  ).toBe(false);
  expect(
    evidenceVisibleTo(line!, { kind: "repo", scope: scopeB }, "ses-b"),
  ).toBe(true);
  expect(evidenceVisibleTo(line!, ADMIN_READER)).toBe(true);

  // Tool level: repo A must not read B's private operator reason.
  const pa = await loadPlugin(a);
  const pb = await loadPlugin(b);
  plugins = [pa, pb];
  rememberSessionDir("ses-a", a);
  rememberSessionDir("ses-b", b);
  const resA = await pa.tools.memory_evidence.execute(
    { ev: "quarantine_released" },
    { sessionID: "ses-a", id: "evidence-a" },
  );
  expect(String((resA as { content?: string }).content ?? "")).not.toContain(
    "BLOCKED_PRIVATE_REASON_308",
  );
  const resB = await pb.tools.memory_evidence.execute(
    { ev: "quarantine_released" },
    { sessionID: "ses-b", id: "evidence-b" },
  );
  expect(String((resB as { content?: string }).content ?? "")).toContain(
    "BLOCKED_PRIVATE_REASON_308",
  );
});

// F1 on #308, noop path: a blocklisted row that is not quarantined still
// exists on disk, so its quarantine_release_noop line must carry its repo
// too — same leak route as the release path.
test("noop release of a BLOCKLISTED repo-B row stamps its evidence with B (#308 F1)", async () => {
  const scopeA = resolveRepo(a);
  const scopeB = resolveRepo(b);
  const T1 = "2026-01-05T00:00:00.000Z";
  seed(T1, scopeB.key, scopeB.path); // no quarantine tag -> noop
  await addBlock(T1, "blocked, never quarantined");

  const result = await releaseQuarantinedMemory(T1, "BLOCKED_NOOP_REASON_308");
  expect(result.released).toBe(false);
  expect(result.reason).toBe("not_quarantined");

  const line = evidenceLines("quarantine_release_noop").find((f) =>
    String(f.reason).includes("BLOCKED_NOOP_REASON_308"),
  );
  expect(line).toBeDefined();
  expect(line!.repo).toBe(scopeB.key);
  expect(
    evidenceVisibleTo(line!, { kind: "repo", scope: scopeA }, "ses-a"),
  ).toBe(false);
  expect(evidenceVisibleTo(line!, ADMIN_READER)).toBe(true);
});

// N1 on #308 (non-blocking finding, fixed with F1): editing a global row in a
// process that carries an ambient repository must not leave that unrelated
// repoPath on the globally readable line.
test("edit of a global row in a repo-B-ambient process leaves no repoB repoPath on the line (#308 N1)", async () => {
  const scopeB = resolveRepo(b);
  const T1 = "2026-01-05T00:00:00.000Z";
  seed(T1, "global");
  // Not the standalone viewer: a shared process whose process scope is B.
  setRepoScope(scopeB);
  await editMemory({
    ts: T1,
    type: "learning",
    scope: "auth",
    content: "edited global row, B ambient",
    reason: "AMBIENT_GLOBAL_REASON_308",
  });
  const line = evidenceLines("viewer_edit").find((f) =>
    String(f.reason).includes("AMBIENT_GLOBAL_REASON_308"),
  );
  expect(line).toBeDefined();
  expect(line!.repo).toBe("global");
  // parseLine only yields keys present on the line: an ambient repoPath
  // surviving the merge would show up here as B's path.
  expect(line!.repoPath).toBeUndefined();
});
