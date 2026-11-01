// Contract (#130, 2026-10-26 security review, medium): `memory_evidence`'s
// `date` is a DATE, not a path. The tool used to join whatever string arrived
// onto evidenceDir(), so a caller could read `<root>/../outside.logfmt` (any
// accessible .logfmt path) or `../YYYY-MM-DD` — the RAW daily memory file,
// which bypasses repo visibility, the blocklist and supersession filtering.
// The fix has two doors: the schema refuses non-date strings at the boundary,
// and evidenceFileFor() refuses impossible dates (2026-02-30 must not roll
// over), never resolves outside the evidence dir, and will not follow a
// symlinked day file out of it. Today's evidence must stay readable.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDir } from "../src/core/config/paths.ts"
import { dateStr } from "../src/core/time.ts";
import { record } from "../src/evidence/record.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { resetState } from "../src/core/state.ts";
import { rememberSessionDir, resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";

let root: string;
let repo: string;
let plugin: LoadedPlugin | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-sec130-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
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

const evidenceTool = (args: Record<string, unknown>): Promise<string> =>
  plugin!.tool.memory_evidence!.execute(args);

test("a path in `date` is refused and nothing outside the evidence dir is returned", async () => {
  plugin = await loadPlugin(repo);
  // The issue's two targets: a sibling file of the memory root, and today's
  // RAW store file (visible/blocked/superseded filtering does not apply to it).
  writeFileSync(join(root, "outside.logfmt"), 'ev=whatever ts="x" note=OUTSIDE_EVIDENCE_MARKER\n');
  await appendMemory({
    type: "context",
    scope: "general",
    content: "RAW_STORE_ROW_MARKER",
    status: "settled",
    repo: "global",
  });

  const up = await evidenceTool({ date: "../../outside" });
  expect(up).not.toContain("OUTSIDE_EVIDENCE_MARKER");
  expect(up).toContain("invalid arguments");

  const backslash = await evidenceTool({ date: "..\\..\\outside" });
  expect(backslash).not.toContain("OUTSIDE_EVIDENCE_MARKER");
  expect(backslash).toContain("invalid arguments");

  const raw = await evidenceTool({ date: `../${dateStr()}` });
  expect(raw).not.toContain("RAW_STORE_ROW_MARKER");
  expect(raw).toContain("invalid arguments");
});

test("an impossible calendar date is refused, not rolled onto another day", async () => {
  plugin = await loadPlugin(repo);
  await record("merge_resolved", { reason: "EVIDENCE_ROLLOVER_PROBE" }, true, "ses-130");
  const out = await evidenceTool({ date: "2026-02-30" });
  // The schema door lets 2026-02-30 through (right SHAPE); the calendar door
  // must refuse it rather than silently reading (or writing toward) March 2.
  expect(out).toContain("calendar date");
  expect(out).not.toContain("EVIDENCE_ROLLOVER_PROBE");
});

test("today's evidence stays readable, implicit and explicit", async () => {
  plugin = await loadPlugin(repo);
  // ses-130 is a session OF this workspace: bound, like every session that
  // reaches a plugin instance. An UNBOUND named session's fresh evidence is
  // private to that session (#128 re-review) — a control for THIS contract
  // must present a resolved identity, not exploit the missing-stamp path.
  rememberSessionDir("ses-130", repo);
  await record("merge_resolved", { reason: "EVIDENCE_PATH_REGRESSION_PROBE" }, true, "ses-130");
  expect(await evidenceTool({})).toContain("EVIDENCE_PATH_REGRESSION_PROBE");
  expect(await evidenceTool({ date: dateStr() })).toContain("EVIDENCE_PATH_REGRESSION_PROBE");
});

test("a day file symlinked out of the evidence dir is not followed", async () => {
  if (process.platform === "win32") return; // symlink rights; the guard is platform-independent
  plugin = await loadPlugin(repo);
  mkdirSync(evidenceDir(), { recursive: true });
  writeFileSync(join(root, "dayfile-target.logfmt"), 'ev=whatever ts="x" note=SYMLINKED_DAYFILE_MARKER\n');
  symlinkSync(join(root, "dayfile-target.logfmt"), join(evidenceDir(), "2099-01-01.logfmt"));
  const out = await evidenceTool({ date: "2099-01-01" });
  expect(out).not.toContain("SYMLINKED_DAYFILE_MARKER");
  expect(out).toContain("blocked");
});
