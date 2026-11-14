// #306: the terminal panel's blocked list must agree with the memory_status
// tool. The TUI process owns no session→repo map, so it resolves the active
// session's repository from its root directory (blockedReaderFor). This file
// pins that helper and its agreement with the tool's own reader; it needs the
// new export, so it is branch-only (the RED scenario lives in
// status-blocked-visibility-306.test.ts).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  rememberSessionDir,
  resetSessionScopes,
  resolveRepo,
} from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import { evidenceDir } from "../src/core/config/paths.ts";
import { dateStr } from "../src/core/time.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { readerFromSid, type Reader } from "../src/store/model/visibility.ts";
import { blockedReaderFor, blockedRecent } from "../src/status/write.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
let a: string;
let b: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-blkrd-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  resetState();
  resetSessionScopes();
});

afterEach(() => {
  resetState();
  resetSessionScopes();
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

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

test("blockedReaderFor resolves the session root to the same reader the tool uses (#306)", () => {
  rememberSessionDir("ses-a", a);
  const toolReader = readerFromSid("ses-a"); // what memory_status builds
  const panelReader = blockedReaderFor(a); // what the TUI builds
  expect(panelReader).toEqual(toolReader);
  expect(panelReader).toEqual({ kind: "repo", scope: resolveRepo(a) });
});

test("the panel reader and the tool see the same blocked lines (#306)", async () => {
  const scopeA = resolveRepo(a);
  const scopeB = resolveRepo(b);
  seedBlocked("ses-BLEEDS-306", "ambiguous_memory", scopeB.key, scopeB.path);
  seedBlocked("ses-OWNED-A-306", "ref_path_missing", scopeA.key, scopeA.path);
  // Session-less ("?") and unstamped: the historical global reading, visible
  // to every reader — unlike an unstamped line a NAMED session wrote, which
  // stays private to that session (evidenceVisibleTo's rule).
  seedBlocked("?", "stamped_nowhere");
  const rows = await blockedRecent(8, blockedReaderFor(a), "ses-a");
  const sids = rows.map((r) => r.sid);
  expect(sids).toContain("ses-OWNED-A-306");
  expect(sids).toContain("?");
  expect(sids).not.toContain("ses-BLEEDS-306");
});

test("no root fails closed to global-only: private lines hidden, never everything shown (#306)", async () => {
  const scopeA = resolveRepo(a);
  seedBlocked("ses-BLEEDS-306", "ambiguous_memory", scopeA.key, scopeA.path);
  seedBlocked("?", "stamped_nowhere");
  const closed: Reader = blockedReaderFor(undefined);
  expect(closed).toEqual({ kind: "global-only" });
  const rows = await blockedRecent(8, closed);
  expect(rows.map((r) => r.sid)).toEqual(["?"]);
});
