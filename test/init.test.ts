// Init phase: memory_init tool behavior. Hermetic — the fixture dir is a plain
// (non-git) temp tree and OPENCODE_CBM_BIN points at a nonexistent binary so
// the graph step degrades to `unavailable` without spawning anything real.
// Scope = directory basename ("repo"), matching the repo-name convention.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfImprovement } from "../index.ts";
import { resetState } from "../src/state.ts";
import { loadAll, isActive } from "../src/memory.ts";
import type { InitSummary } from "../src/init.ts";

let memoryDir: string;
let fixture: string;
let init: { execute(args: { force?: boolean; mode?: string }): Promise<string> };

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "osi-init-"));
  memoryDir = join(root, "memory");
  process.env.OPENCODE_MEMORY_DIR = memoryDir;
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  process.env.OPENCODE_CBM_BIN = join(root, "no-such-cbm");
  fixture = join(root, "repo");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({ name: "fixture-app", scripts: { test: "vitest run", lint: "eslint .", deploy: "x" } }),
  );
  resetState();
  const hooks = await SelfImprovement({ directory: fixture } as never);
  init = hooks.tool!.memory_init as never;
});

afterEach(() => {
  delete process.env.OPENCODE_CBM_BIN;
});

describe("memory_init", () => {
  test("writes script pattern memories + an init stamp", async () => {
    const out = await init.execute({});
    expect(out).toContain("Initialized repo");
    expect(out).toContain("Graph: unavailable");
    expect(out).toContain("npm run test");
    expect(out).toContain("npm run lint");

    const mems = (await loadAll()).filter(isActive);
    const patterns = mems.filter((m) => m.type === "pattern" && m.scope === "repo");
    expect(patterns.length).toBe(2);
    expect(patterns.every((m) => m.tags?.includes("init"))).toBe(true);

    const stamps = mems.filter((m) => m.tags?.includes("init-stamp"));
    expect(stamps.length).toBe(1);
    expect(stamps[0].content).toContain("repo=repo");
    expect(stamps[0].content).toContain("head=-");
  });

  test("idempotent: second run is a no-op, no duplicate memories", async () => {
    await init.execute({});
    const out2 = await init.execute({});
    expect(out2).toContain("Already initialized");

    const mems = (await loadAll()).filter(isActive);
    expect(mems.filter((m) => m.type === "pattern" && m.scope === "repo").length).toBe(2);
    expect(mems.filter((m) => m.tags?.includes("init-stamp")).length).toBe(1);
  });

  test("force re-derives without duplicating", async () => {
    const out = await init.execute({ force: true });
    expect(out).not.toContain("Already initialized");

    const mems = (await loadAll()).filter(isActive);
    const patterns = mems.filter((m) => m.type === "pattern" && m.scope === "repo");
    expect(patterns.length).toBe(2);
    const stamps = mems.filter((m) => m.tags?.includes("init-stamp"));
    expect(stamps.length).toBe(1);
  });

  test("mode passthrough; force with unchanged HEAD collapses everything", async () => {
    const out = await init.execute({ force: true, mode: "full" });
    expect(out).toContain("[mode=full]");
    const out2 = await init.execute({ force: true });
    expect(out2).not.toContain("Already initialized");
    expect(out2).toContain("written=0");
  });
});

describe("init internals", () => {
  test("gitRootOf/gitHead degrade on non-git dirs", async () => {
    const { gitRootOf, gitHead, detectScripts } = await import("../src/init.ts");
    expect(await gitRootOf(fixture)).toBe(fixture);
    expect(await gitHead(fixture)).toBe("-");
    const recs = await detectScripts(fixture);
    expect(recs.map((r) => r.key).sort()).toEqual(["lint", "test"]);
  });

  test("formatInit renders a readable summary; runInit returns one", async () => {
    const { formatInit, runInit } = await import("../src/init.ts");
    const s: InitSummary = {
      scope: "x",
      root: fixture,
      head: "abc1234",
      graph: { action: "unavailable", mode: "full" },
      scripts: [],
      skipped: false,
      written: 0,
      collapsed: 0,
      blocked: 0,
    };
    expect(formatInit(s)).toContain("Graph: unavailable");
    const real = await runInit({ liveRoot: fixture, force: true });
    expect(formatInit(real)).toContain("Memories: written=");
  });
});