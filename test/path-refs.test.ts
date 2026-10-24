// Path-ref existence gate contract: repo-relative path refs in a SETTLED
// write must exist under liveRoot or the write blocks with ref_path_missing;
// open planning threads are exempt; paths outside the repo's jurisdiction
// (bare names, absolute, ~, $VAR, URLs, `..`) are trusted as before and never
// produce a block.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkablePathRefs, gate1 } from "../src/resolver.ts";
import { runWriteGate, type GateContext } from "../src/gates.ts";

describe("checkablePathRefs — which refs are policed", () => {
  test("repo-qualified paths are checkable; line suffix stripped", () => {
    expect(checkablePathRefs("see src/resolver.ts and ./a/b.ts:108")).toEqual([
      "src/resolver.ts",
      "./a/b.ts",
    ]);
  });

  test("bare names are not checkable (may live anywhere)", () => {
    expect(checkablePathRefs("undo.ts rewrites the daily file")).toEqual([]);
  });

  test("absolute, home, env-var, parent-escaping, and URL refs are skipped", () => {
    expect(
      checkablePathRefs(
        "config at /etc/passwd.ts, key at ~/src/a.ts, build at $ROOT/src/b.ts, " +
          "escape at ../outside/c.ts, site at https://example.com/p/index.ts",
      ),
    ).toEqual([]);
  });

  test("dotted first segment reads as a hostname, not a directory", () => {
    expect(checkablePathRefs("listed on opencode.ai/docs/index.ts and awesome.dev/x.ts")).toEqual([]);
  });

  test("dedupes repeated refs", () => {
    expect(checkablePathRefs("src/a.ts ... src/a.ts again")).toEqual(["src/a.ts"]);
  });

  test("the whole extension is kept: .tsx and .jsx are not cut to .ts and .js", () => {
    expect(checkablePathRefs("see src/Button.tsx, src/App.jsx:12 and src/a.ts.")).toEqual([
      "src/Button.tsx",
      "src/App.jsx",
      "src/a.ts",
    ]);
  });

  test("other extensions that start with ts/js are not refs", () => {
    expect(
      checkablePathRefs(
        "src/config.json, x/opencode.jsonc, s/tsconfig.tsbuildinfo, " +
          "s/__snapshots__/B.tsx.snap and d/app.js.map",
      ),
    ).toEqual([]);
  });
});

describe("gate1 — existence check against liveRoot", () => {
  let root: string;
  let liveRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osi-pr-"));
    liveRoot = join(root, "repo");
    mkdirSync(join(liveRoot, "src"), { recursive: true });
    mkdirSync(join(liveRoot, ".git"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const run = (content: string) =>
    gate1({ content, scope: "demo", liveRoot, scopeMemories: [] });

  test("live path refs pass; ghost path refs are reported missing", async () => {
    await Bun.write(join(liveRoot, "src", "real.ts"), "export const x = 1;\n");
    const ok = await run("gate1 lives in src/real.ts");
    expect(ok.missingPaths).toEqual([]);
    expect(ok.refs).toBeGreaterThan(0);

    const ghost = await run("the viewer in src/ghost_pipeline_removed.ts uses redis");
    expect(ghost.missingPaths).toEqual(["src/ghost_pipeline_removed.ts"]);
  });

  test("line-number refs and relative ./ refs resolve", async () => {
    await Bun.write(join(liveRoot, "src", "real.ts"), "export const x = 1;\n");
    expect((await run("see src/real.ts:42 and ./src/real.ts")).missingPaths).toEqual([]);
  });

  test("no refs at all short-circuits with empty missingPaths", async () => {
    const r = await run("no code references here whatsoever");
    expect(r.refs).toBe(0);
    expect(r.missingPaths).toEqual([]);
  });

  test("unverifiable liveRoot (no tree) never flags missing paths", async () => {
    const r = await gate1({
      content: "see src/whatever.ts",
      scope: "demo",
      liveRoot: join(root, "does-not-exist"),
      scopeMemories: [],
    });
    expect(r.missingPaths).toEqual([]);
  });
});

describe("runWriteGate — ref_path_missing block", () => {
  let root: string;
  let liveRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osi-prg-"));
    process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
    liveRoot = join(root, "repo");
    mkdirSync(join(liveRoot, "src"), { recursive: true });
    mkdirSync(join(liveRoot, ".git"), { recursive: true });
  });

  afterEach(() => {
    delete process.env.OPENCODE_MEMORY_DIR;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  const ctx = (): GateContext => ({
    liveRoot,
    evidenceCalls: [],
    hasGateCheck: false,
    hasEngagement: true, // engagement would have promoted the ghost before this fix
  });

  test("settled write citing a nonexistent repo path is blocked with a hint", async () => {
    await Bun.write(join(liveRoot, "src", "real.ts"), "export const x = 1;\n");
    const outcome = await runWriteGate(
      {
        type: "learning",
        scope: "demo",
        content: "The viewer server in src/ghost_pipeline_removed.ts runs on port 9999.",
      },
      ctx(),
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("ref_path_missing");
    expect(outcome.hint).toContain("src/ghost_pipeline_removed.ts");
  });

  test("settled write citing a real repo path promotes", async () => {
    await Bun.write(join(liveRoot, "src", "real.ts"), "export const x = 1;\n");
    const outcome = await runWriteGate(
      { type: "learning", scope: "demo", content: "The gate lives in src/real.ts and exports x." },
      ctx(),
    );
    expect(outcome.action).toBe("promoted");
  });

  test("settled write citing real .tsx, .jsx and .json files promotes", async () => {
    for (const f of ["Button.tsx", "App.jsx", "config.json"]) {
      await Bun.write(join(liveRoot, "src", f), "x\n");
    }
    const outcome = await runWriteGate(
      {
        type: "learning",
        scope: "demo",
        content: "src/Button.tsx renders inside src/App.jsx; flags come from src/config.json.",
      },
      ctx(),
    );
    expect(outcome.action).toBe("promoted");
  });

  test("open planning thread may cite a not-yet-existing file", async () => {
    const outcome = await runWriteGate(
      {
        type: "context",
        scope: "demo",
        content: "Plan: add retry logic in src/retry_planned.ts next sprint.",
        status: "open",
      },
      ctx(),
    );
    expect(outcome.reason).not.toBe("ref_path_missing");
  });
});
