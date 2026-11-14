// Contract (#131, 2026-10-26 security review, medium): a row id is a pointer,
// not authority. memory_merge_review used to resolve both seats store-wide and
// mutate whichever ts the arguments named — a session that learned another
// repository's timestamp (the separately reported evidence traversal was one
// way) could retire that row, or revive another repo's superseded survivor as
// canonical. The fix authorizes BOTH seats through the caller's Reader — the
// same visibility predicate every read path uses — under the update-order
// mutation lock, so a blocked merge mutates nothing and records no evidence.
// Global (explicit or unstamped) rows stay mergeable from anywhere; that is
// now stated in the tool contract instead of granted implicitly.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDir } from "../src/core/config/paths.ts";
import { dateStr } from "../src/core/time.ts";
import { parseLine } from "../src/core/logfmt/format.ts";
import { readLines } from "../src/core/logfmt/read.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { loadAll } from "../src/store/files/load.ts";
import { markSuperseded } from "../src/store/files/supersede.ts";
import { addBlock, removeBlock } from "../src/store/blocklist.ts";
import { type Memory } from "../src/store/model/memory.ts";
import { isActive } from "../src/store/model/predicates.ts";
import { resetState } from "../src/core/state.ts";
import {
  bindSessionProvisional,
  resetSessionScopes,
  resolveRepo,
  setRepoScope,
} from "../src/identity/repokey.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
let a: string;
let b: string;
let plugin: LoadedPlugin | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-sec131-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
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
  removeStore(root);
});

// Rows are seeded with an EXPLICIT repo stamp (ambient scope is null while
// seeding, so nothing else leaks in): these are "known by other means" ids —
// exactly what the issue says must not be authority.
async function seedRow(
  dir: string,
  marker: string,
  repoTag?: string,
): Promise<string> {
  const scope = resolveRepo(dir);
  return appendMemory({
    type: "context",
    scope: "merges",
    content: marker,
    status: "settled",
    repo: repoTag ?? scope.key,
    ...(repoTag === "global" ? {} : { repoPath: scope.path }),
  });
}

const byId = async (ts: string): Promise<Memory | undefined> =>
  (await loadAll()).find((m) => m.ts === ts);

const merge = (args: Record<string, unknown>): Promise<string> =>
  plugin!.tool.memory_merge_review!.execute(args);

async function mergeResolvedLines(): Promise<boolean> {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  if (!existsSync(file)) return false;
  return (await readLines(file)).some(
    (l) => parseLine(l)?.ev === "merge_resolved",
  );
}

test("repository B's row is not retired from a session in A — even with both ids known", async () => {
  plugin = await loadPlugin(a); // ambient caller identity: repo A
  const bLoser = await seedRow(b, "B_MERGE_TARGET_ROW");
  const aSurvivor = await seedRow(a, "A_MERGE_SURVIVOR_ROW");

  const out = await merge({
    loser: bLoser,
    survivor: aSurvivor,
    reason: "cross-repo attempt",
  });
  expect(out).toContain("another repository");
  expect(out).not.toContain("canonical");

  const row = (await byId(bLoser))!;
  expect(isActive(row)).toBe(true);
  expect(row.superseded_by).toBeUndefined();
  // A blocked resolution leaves no audit lie behind either.
  expect(await mergeResolvedLines()).toBe(false);
});

test.each(["foreign", "own", "global"])(
  "a blocked %s loser cannot be retired through its known id (#204)",
  async (seat) => {
    plugin = await loadPlugin(a);
    bindSessionProvisional("merge-204", a);
    const loser = await seedRow(
      seat === "own" ? a : b,
      "BLOCKED_LOSER",
      seat === "global" ? "global" : undefined,
    );
    const survivor = await seedRow(a, "OWN_SURVIVOR");
    // A refused merge must not revive the survivor as a side effect either.
    await markSuperseded(survivor, {
      superseded_by: "2099-01-01T00:00:00.000Z",
      reason: "prior decision",
    });
    const loserRow = await byId(loser);
    if (!loserRow) throw new Error("seeded loser missing");
    await addBlock(loser, "human block");
    expect(await byId(loser)).toBeUndefined(); // pin the hidden-row premise
    const before = readFileSync(loserRow.file, "utf8");
    const out = await plugin.tools.memory_merge_review.execute(
      { loser, survivor, reason: "known id is not authority" },
      { sessionID: "merge-204", id: "merge-204-call" },
    );
    expect(readFileSync(loserRow.file, "utf8")).toBe(before);
    expect(out.content).not.toContain("is canonical");
    expect(await mergeResolvedLines()).toBe(false);
    expect(await removeBlock(loser)).toBe(true);
    const restored = await byId(loser);
    if (!restored) throw new Error("unblocked loser missing");
    expect(restored.superseded_by).toBeUndefined();
    expect(isActive(restored)).toBe(true);
  },
);

test("a missing loser is refused before reviving a valid survivor (#204)", async () => {
  plugin = await loadPlugin(a);
  bindSessionProvisional("merge-204", a);
  const survivor = await seedRow(a, "OWN_SURVIVOR");
  await markSuperseded(survivor, {
    superseded_by: "2099-01-01T00:00:00.000Z",
    reason: "prior decision",
  });
  const survivorRow = await byId(survivor);
  if (!survivorRow) throw new Error("seeded survivor missing");
  const before = readFileSync(survivorRow.file, "utf8");
  const out = await plugin.tools.memory_merge_review.execute(
    { loser: "2098-01-01T00:00:00.000Z", survivor, reason: "missing loser" },
    { sessionID: "merge-204", id: "merge-204-call" },
  );
  expect(out.content).not.toContain("is canonical");
  expect(readFileSync(survivorRow.file, "utf8")).toBe(before);
  expect(await mergeResolvedLines()).toBe(false);
});

test("a foreign row is not promoted (or revived) from the survivor seat", async () => {
  plugin = await loadPlugin(a);
  const bSurvivor = await seedRow(b, "B_CANONICAL_ROW");
  expect(
    await markSuperseded(bSurvivor, {
      superseded_by: "2099-01-01T00:00:00.000Z",
      reason: "drift",
      symbol: "b",
      from: "old",
      to: "new",
    }),
  ).toBe(true);
  const aLoser = await seedRow(a, "A_MERGE_LOSER_ROW");

  const out = await merge({
    loser: aLoser,
    survivor: bSurvivor,
    reason: "revive attempt",
  });
  expect(out).toContain("another repository");
  expect(out).not.toContain("canonical");

  expect(isActive((await byId(bSurvivor))!)).toBe(false); // still superseded
  expect(isActive((await byId(aLoser))!)).toBe(true); // the mutation never started
  expect(await mergeResolvedLines()).toBe(false);
});

test("global rows stay mergeable from any repository — the stated contract", async () => {
  plugin = await loadPlugin(a);
  const loser = await seedRow(b, "GLOBAL_MERGE_LOSER", "global");
  const survivor = await seedRow(b, "GLOBAL_MERGE_SURVIVOR", "global");

  const out = await merge({ loser, survivor, reason: "global canonical" });
  expect(out).toContain(`${survivor} is canonical`);
  expect(isActive((await byId(loser))!)).toBe(false);
});

test("a same-repository merge still resolves and leaves the promised evidence", async () => {
  plugin = await loadPlugin(a);
  const loser = await seedRow(a, "A_MERGE_OWN_LOSER");
  const survivor = await seedRow(a, "A_MERGE_OWN_SURVIVOR");

  const out = await merge({ loser, survivor, reason: "own canonical" });
  expect(out).toContain(`${survivor} is canonical`);
  const row = (await byId(loser))!;
  expect(isActive(row)).toBe(false);
  expect(row.superseded_by).toBe(survivor);
  expect(await mergeResolvedLines()).toBe(true);
});
