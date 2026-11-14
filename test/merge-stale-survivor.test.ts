// #126: a stale memory_merge_review must not revive a survivor that a later
// memory_update already retired. The merge handler used to run
// `markSuperseded(loser, by=survivor)` then `clearSuperseded(survivor)` with no
// provenance check, so applying a review whose survivor had been superseded in
// the meantime (S -> S2 by an update) erased the update's marker and brought S
// back active NEXT TO S2 — two active rows for one statement, and the update's
// supersession destroyed. The guard: the survivor's marker is cleared only when
// it points at this review's loser (or carries the review's reason); anything
// else refuses the apply before any mutation, so the loser is left untouched.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemory } from "../src/store/files/append.ts";
import { loadAll } from "../src/store/files/load.ts";
import { type Memory } from "../src/store/model/memory.ts";
import { isActive } from "../src/store/model/predicates.ts";
import { resetState, setCurrent } from "../src/core/state.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { loadPlugin } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-stale-"));
  // Seeds are written with a null scope so they stay unstamped (legacy =
  // global visibility) and the freshly loaded plugin can see them (#149).
  setRepoScope(null);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  resetState();
  resetSessionScopes();
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

type Tool = Record<string, { execute: (args: any) => Promise<string> }>;

async function tools(): Promise<Tool> {
  const loaded = await loadPlugin(liveRoot);
  setCurrent({ sessionID: "stale", callID: "C1", tool: "memory_merge_review" });
  return loaded.tool;
}

async function seed(content: string): Promise<string> {
  return appendMemory({ type: "pattern", scope: "stalerev", content });
}

async function rows(): Promise<Memory[]> {
  return (await loadAll()).filter(
    (m) => m.scope === "stalerev" && m.type === "pattern",
  );
}

async function byId(ts: string): Promise<Memory | undefined> {
  return (await rows()).find((m) => m.ts === ts);
}

describe("memory_merge_review stale-survivor provenance guard (#126)", () => {
  test("a survivor superseded by a later update is NOT revived; the merge refuses and touches nothing", async () => {
    const L = await seed("zeta merge loser row keeps the stale jest wording");
    const S = await seed("zeta merge survivor row keeps the bun wording");

    // The later supersession: memory_update retires S in favour of S2 AFTER
    // the review was filed. This is the state the ticket's RED scenario names.
    const upd = await (await tools()).memory_update.execute({
      type: "pattern",
      scope: "stalerev",
      status: "open",
      query: S,
      content: "zeta merge survivor row keeps the bun wording refreshed",
    });
    expect(upd).toContain(`superseded ${S}`);
    const s2 = (await rows()).find(
      (m) => m.ts !== S && isActive(m) && m.content.includes("refreshed"),
    )!;
    expect(s2).toBeTruthy();
    expect((await byId(S))?.superseded_by).toBe(s2.ts);

    // The stale review applies now: survivor S carries a supersession pointing
    // at S2, which is neither this review's loser nor its reason.
    const out = await (await tools()).memory_merge_review.execute({
      loser: L,
      survivor: S,
      reason: "consolidate proposal filed before the update",
    });

    // GREEN contract: refuse, naming the later supersession (S2) as the live row.
    expect(out).toContain("blocked");
    expect(out).not.toContain("canonical");
    expect(out).toContain(s2.ts);
    // S stays retired, S2 stays live, L is untouched — no half-applied merge.
    expect(isActive((await byId(S))!)).toBe(false);
    expect((await byId(S))?.superseded_by).toBe(s2.ts);
    expect(isActive((await byId(s2.ts))!)).toBe(true);
    expect((await byId(L))?.superseded_by).toBeUndefined();
    expect(isActive((await byId(L))!)).toBe(true);
  });

  test("a survivor superseded by this review's own loser still merges (normal case)", async () => {
    const L = await seed("zeta merge loser row keeps the stale jest wording");
    const S = await seed("zeta merge survivor row keeps the bun wording");
    // The legitimate revival: the loser had superseded the survivor first.
    const { markSuperseded } = await import("../src/store/files/supersede.ts");
    expect(
      await markSuperseded(S, {
        superseded_by: L,
        reason: "drift",
        symbol: "runner",
        from: "jest",
        to: "bun",
      }),
    ).toBe(true);

    const out = await (await tools()).memory_merge_review.execute({
      loser: L,
      survivor: S,
      reason: "bun-native repo; jest note predates the bun migration",
    });

    expect(out).toContain(`${S} is canonical`);
    expect(out).toContain("active again");
    expect(isActive((await byId(S))!)).toBe(true);
    expect(isActive((await byId(L))!)).toBe(false);
  });
});
