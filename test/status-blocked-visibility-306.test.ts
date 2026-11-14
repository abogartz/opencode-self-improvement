// #306 (decision #213 B): the recent-blocked-writes list follows the SAME
// evidence-visibility rule as memory_evidence. RED on main: a `write_blocked`
// line stamped to repository B — distinctive sid — printed inside a repository
// -A session's memory_status, leaking B's session ids and gate reasons. GREEN:
// repo-A status omits the line and shows only its own blocked writes; the
// admin reader still sees all; aggregate STORE counts are identical for every
// reader (machine-wide by decision, deliberately NOT scoped). This file uses
// only exports that exist on main so it fails for exactly the stated reason;
// the new reader helper is pinned in status-blocked-reader-306.test.ts.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import {
  rememberSessionDir,
  resetSessionScopes,
  resolveRepo,
} from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { resetCaptureCooldowns } from "../src/index.ts";
import { evidenceDir } from "../src/core/config/paths.ts";
import { dateStr } from "../src/core/time.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { ADMIN_READER } from "../src/store/model/visibility.ts";
import { blockedRecent } from "../src/status/write.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
let a: string;
let b: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-blkvis-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  resetCaptureCooldowns();
  plugins = [];
});

afterEach(async () => {
  for (const p of plugins) await p.cleanup();
  plugins = [];
  resetState();
  resetSessionScopes();
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

// One write_blocked evidence line, stamped like the gate writes it in a
// session whose repository resolved to `repo`/`repoPath`.
function seedBlocked(
  sid: string,
  reason: string,
  repo?: string,
  repoPath?: string,
): void {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    formatLine({
      ev: "write_blocked",
      ts: new Date().toISOString(),
      sid,
      reason,
      gate: 1,
      flags: "[]",
      ...(repo ? { repo, repoPath } : {}),
    }) + "\n",
  );
}

function storeLine(content: string): string {
  const lines = content.split("\n");
  const i = lines.indexOf("STORE");
  return i >= 0 ? lines[i + 1]! : "";
}

test("repo-A memory_status omits a repo-B blocked line and shows its own (#306 RED on main)", async () => {
  const scopeA = resolveRepo(a);
  const scopeB = resolveRepo(b);
  seedBlocked("ses-BLEEDS-306", "ambiguous_memory", scopeB.key, scopeB.path);
  seedBlocked("ses-OWNED-A-306", "ref_path_missing", scopeA.key, scopeA.path);
  const pa = await loadPlugin(a);
  plugins = [pa];
  rememberSessionDir("ses-a", a);
  const res = await pa.tools.memory_status.execute(
    {},
    { sessionID: "ses-a", id: "status-a" },
  );
  const content = String((res as { content?: string }).content ?? "");
  // On main blockedRecent has no filter: the repo-B sid prints here — RED.
  expect(content).not.toContain("ses-BLEEDS-306");
  expect(content).toContain("ses-OWNED-A-306");
});

test("admin reader sees every blocked line; repo-B sees its own, not A's (#306)", async () => {
  const scopeA = resolveRepo(a);
  const scopeB = resolveRepo(b);
  seedBlocked("ses-BLEEDS-306", "ambiguous_memory", scopeB.key, scopeB.path);
  seedBlocked("ses-OWNED-A-306", "ref_path_missing", scopeA.key, scopeA.path);
  const all = await blockedRecent(9, ADMIN_READER);
  expect(all.map((r) => r.sid)).toContain("ses-BLEEDS-306");
  expect(all.map((r) => r.sid)).toContain("ses-OWNED-A-306");
  const pb = await loadPlugin(b);
  plugins = [pb];
  rememberSessionDir("ses-b", b);
  const res = await pb.tools.memory_status.execute(
    {},
    { sessionID: "ses-b", id: "status-b" },
  );
  const content = String((res as { content?: string }).content ?? "");
  expect(content).toContain("ses-BLEEDS-306"); // B keeps its own history
  expect(content).not.toContain("ses-OWNED-A-306");
});

test("aggregate STORE counts are identical for every reader — machine-wide by decision (#306)", async () => {
  const scopeA = resolveRepo(a);
  const scopeB = resolveRepo(b);
  seedBlocked("ses-BLEEDS-306", "ambiguous_memory", scopeB.key, scopeB.path);
  seedBlocked("ses-OWNED-A-306", "ref_path_missing", scopeA.key, scopeA.path);
  const pa = await loadPlugin(a);
  const pb = await loadPlugin(b);
  plugins = [pa, pb];
  rememberSessionDir("ses-a", a);
  rememberSessionDir("ses-b", b);
  const ra = await pa.tools.memory_status.execute(
    {},
    { sessionID: "ses-a", id: "status-a" },
  );
  const rb = await pb.tools.memory_status.execute(
    {},
    { sessionID: "ses-b", id: "status-b" },
  );
  const ca = String((ra as { content?: string }).content ?? "");
  const cb = String((rb as { content?: string }).content ?? "");
  // The blocked lists differ (that is the fix); the STORE counts must not.
  expect(ca).not.toContain("ses-BLEEDS-306");
  expect(cb).toContain("ses-BLEEDS-306");
  expect(storeLine(ca)).toBe(storeLine(cb));
});
