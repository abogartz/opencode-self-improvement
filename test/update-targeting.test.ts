// Row-targeting for memory_update / memory_merge_review.
// Contract: `query` selects WHICH row an update rewrites — exact row id (ts), a
// clock fragment, or a unique content substring. Selecting by "newest active row
// of scope+type" regardless of `query` let two back-to-back updates in the same
// scope+type clobber each other: the second call superseded the row the first
// had just written, while the row it was meant to rewrite stayed live. A query
// that matches nothing, or matches more than one row, must therefore fail closed
// (write nothing) instead of guessing.
// Second contract: memory_merge_review declares a survivor canonical, so the
// survivor must come out recallable — clearing a supersession it already carried.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dateStr, memoryRoot, snapshotDir } from "../src/config.ts";
import { parseLine, readLines } from "../src/logfmt.ts";
import {
  appendMemory,
  clearSuperseded,
  isActive,
  loadAll,
  markSuperseded,
  resolveMemoryTarget,
  type Memory,
} from "../src/memory.ts";
import { resetState, setCurrent } from "../src/state.ts";
import { setRepoScope } from "../src/repokey.ts";
import { loadPlugin } from "./harness.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-upd-"));
  // Tests seed rows via appendMemory BEFORE loading the plugin; null scope
  // keeps those seeds unstamped (legacy = global visibility) so each test's
  // freshly loaded plugin (its own liveRoot) sees them.
  setRepoScope(null);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// Deliberately token-disparate so GATE-3 overlap/collapse never fires and each
// row is addressable by a distinct substring.
const ALPHA = "alpha lint step runs eslint over packages cli";
const BETA = "beta deploy builds the docker registry image";
const GAMMA = "gamma changelog notes drafted per release";

type Tool = Record<string, { execute: (args: any) => Promise<string> }>;

async function tools(): Promise<Tool> {
  const loaded = await loadPlugin(liveRoot);
  setCurrent({ sessionID: "upd", callID: "C1", tool: "memory_update" });
  return loaded.tool;
}

async function seed(content: string, extra: { tags?: string[]; status?: "open" | "settled" } = {}): Promise<string> {
  return appendMemory({ type: "pattern", scope: "targeting", content, ...extra });
}

async function rows(): Promise<Memory[]> {
  return (await loadAll()).filter((m) => m.scope === "targeting" && m.type === "pattern");
}

async function byId(ts: string): Promise<Memory | undefined> {
  return (await rows()).find((m) => m.ts === ts);
}

async function update(args: Record<string, unknown>): Promise<string> {
  const t = await tools();
  return t.memory_update.execute({ type: "pattern", scope: "targeting", status: "open", ...args });
}

describe("memory_update row targeting", () => {
  test("query = row id rewrites THAT row, leaving newer rows untouched", async () => {
    const a = await seed(ALPHA);
    const b = await seed(BETA);
    const c = await seed(GAMMA); // newest — the old code always hit this one

    const out = await update({ query: a, content: "alpha lint step runs oxlint instead" });
    expect(out).toContain(`superseded ${a}`);

    expect((await byId(a))?.superseded_by).toBeTruthy();
    expect(isActive((await byId(b))!)).toBe(true);
    expect(isActive((await byId(c))!)).toBe(true);
    const replacements = (await rows()).filter((m) => m.content.includes("oxlint"));
    expect(replacements.length).toBe(1);
    expect(isActive(replacements[0])).toBe(true);
  });

  test("two sequential updates in one scope+type each land on their own row", async () => {
    const a = await seed(ALPHA);
    const b = await seed(BETA);
    const c = await seed(GAMMA);

    const first = await update({ query: a, content: "alpha lint step runs oxlint instead" });
    const second = await update({ query: c, content: "gamma changelog notes are auto-generated" });
    expect(first).toContain(`superseded ${a}`);
    expect(second).toContain(`superseded ${c}`);

    expect(isActive((await byId(a))!)).toBe(false);
    expect(isActive((await byId(b))!)).toBe(true);
    expect(isActive((await byId(c))!)).toBe(false);
    // The row written by the FIRST update must survive: this is the clobber.
    const alpha2 = (await rows()).find((m) => m.content.includes("oxlint"));
    const gamma2 = (await rows()).find((m) => m.content.includes("auto-generated"));
    expect(alpha2 && isActive(alpha2)).toBe(true);
    expect(gamma2 && isActive(gamma2)).toBe(true);
  });

  test("a unique content substring selects the row", async () => {
    const a = await seed(ALPHA);
    const c = await seed(GAMMA);

    const out = await update({ query: "docker registry", content: "beta deploy pushes to GHCR" });
    expect(out).toContain("blocked");
    expect(out).not.toContain(`superseded ${a}`);

    const ok = await update({ query: "changelog", content: "gamma changelog notes are auto-generated" });
    expect(ok).toContain(`superseded ${c}`);
    expect(isActive((await byId(c))!)).toBe(false);
  });

  test("an unmatched query writes nothing", async () => {
    await seed(ALPHA);
    const before = await rows();

    const out = await update({ query: "no-such-row-anywhere", content: "beta deploy builds a tarball" });
    expect(out).toContain("blocked");
    expect(out).toContain("Nothing was written.");
    expect((await rows()).length).toBe(before.length);
  });

  test("an ambiguous query writes nothing and lists the candidates", async () => {
    const a = await seed("delta periodic vacuum job sweeps stale sessions alpha");
    const b = await seed("delta periodic vacuum job sweeps stale sessions beta");
    const before = await rows();

    const out = await update({ query: "periodic vacuum job", content: "delta periodic vacuum job runs nightly" });
    expect(out).toContain("blocked");
    expect(out).toContain(a);
    expect(out).toContain(b);
    expect((await rows()).length).toBe(before.length);
  });

  test("no query keeps the documented default: newest active row of scope+type", async () => {
    const a = await seed(ALPHA);
    const c = await seed(GAMMA);

    const out = await update({ content: "gamma changelog notes are auto-generated" });
    expect(out).toContain(`superseded ${c}`);
    expect(isActive((await byId(a))!)).toBe(true);
  });

  test("resolveMemoryTarget: id, clock fragment, substring, miss", async () => {
    const a = await seed(ALPHA);
    const b = await seed(BETA);
    const all = await rows();

    expect(resolveMemoryTarget(all, a)).toMatchObject({ status: "ok", target: { ts: a } });
    expect(resolveMemoryTarget(all, b.slice(11, 23))).toMatchObject({ status: "ok", target: { ts: b } });
    expect(resolveMemoryTarget(all, "eslint")).toMatchObject({ status: "ok", target: { ts: a } });
    expect(resolveMemoryTarget(all, "nothing matches this")).toEqual({ status: "not_found" });
    expect(resolveMemoryTarget([], "anything")).toEqual({ status: "not_found" });
    expect(resolveMemoryTarget(all)).toMatchObject({ status: "ok", target: { ts: b } });
  });
});

describe("memory_merge_review survivor revival", () => {
  test("a survivor that was itself superseded becomes recallable", async () => {
    const stale = await seed("epsilon test runner is jest with coverage thresholds");
    const revive = await seed("epsilon test runner is bun test", { tags: ["bun"], status: "settled" });
    const other = await seed(GAMMA);
    // The state the bug produced: `revive` is hidden behind `other`.
    expect(
      await markSuperseded(revive, {
        superseded_by: other,
        reason: "drift",
        symbol: "runner",
        from: "jest",
        to: "bun",
      }),
    ).toBe(true);
    expect(isActive((await byId(revive))!)).toBe(false);

    const loaded = await loadPlugin(liveRoot);
    const out = await loaded.tool.memory_merge_review.execute({
      loser: stale,
      survivor: revive,
      reason: "bun-native repo; jest note predates the bun migration",
    });

    expect(out).toContain(`${revive} is canonical`);
    expect(out).toContain("active again");
    expect(isActive((await byId(stale))!)).toBe(false);
    expect((await byId(stale))?.superseded_by).toBe(revive);

    const m = (await byId(revive))!;
    expect(isActive(m)).toBe(true);
    expect(m.superseded_by).toBeUndefined();
    expect(m.reason).toBeUndefined();
    // Revival rewrites the line, so the rest of the marker must be gone and
    // unrelated fields must survive verbatim.
    const raw = (await readLines(join(memoryRoot(), `${dateStr()}.logfmt`)))
      .map((l) => parseLine(l))
      .find((f) => f?.ts === revive)!;
    for (const key of ["superseded_by", "reason", "symbol", "from", "to", "entity"]) {
      expect(raw[key]).toBeUndefined();
    }
    expect(m.content).toBe("epsilon test runner is bun test");
    expect(m.tags).toContain("bun");
    expect(m.status).toBe("settled");
  });

  test("clearSuperseded is a no-op on an active or missing row", async () => {
    const a = await seed(ALPHA);
    expect(await clearSuperseded(a)).toBe(false);
    expect(await clearSuperseded("2000-01-01T00:00:00.000Z")).toBe(false);
    expect(isActive((await byId(a))!)).toBe(true);
  });

  test("snapshots keep the <stamp>-<original> contract /undo depends on", async () => {
    const a = await seed(ALPHA);
    const b = await seed(GAMMA);
    expect(await markSuperseded(a, { superseded_by: b, reason: "update" })).toBe(true);
    expect(await clearSuperseded(b)).toBe(false);
    await update({ query: a, content: "alpha lint step runs oxlint instead" });

    const names = readdirSync(snapshotDir());
    expect(names.length).toBeGreaterThan(0);
    // Every snapshot must map back onto a real store file once its stamp is
    // stripped — a same-millisecond collision or a tagged name breaks /undo.
    for (const n of names) {
      expect(n).toMatch(/^\d+-\d{4}-\d{2}-\d{2}\.logfmt$/);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});
