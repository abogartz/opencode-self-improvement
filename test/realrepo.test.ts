// Real-world scenario suite: drives the resolver and the full gate pipeline
// against a LIVE repo (Babylon.js by default) instead of a throwaway fixture.
// The memory store stays hermetic (OPENCODE_MEMORY_DIR -> temp dir, invariant
// I2); only the "live" source tree is the real repo, read-only. This is where
// resolver blind spots show up that tiny fixtures cannot (case-sensitive globs
// missing -pure.ts / .pure.ts siblings, node_modules shadowing src, compiled
// dist beating source, multi-thousand-file fallback globs).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { dateStr, evidenceDir, memoryRoot } from "../src/config.ts";
import { extractCallForms, findLiveCall, sameArgs } from "../src/resolver.ts";
import { runWriteGate } from "../src/gates.ts";
import { afterTool, evidenceCalls, hasEngagement, hasGateCheck } from "../src/triggers.ts";
import { formatLine, parseLine, type Fields } from "../src/logfmt.ts";
import { resetState, setCurrent } from "../src/state.ts";

const CANDIDATES = ["~/Documents/Babylon.js", "~/Documents/BabylonJS"];
const LIVE_ROOT = CANDIDATES.map((p) => p.replace(/^~/, homedir())).find((p) =>
  existsSync(join(p, "package.json")),
);

const skip = LIVE_ROOT ? describe : describe.skip;

skip("R1 — real-repo resolver fidelity (MeshBuilder is split across .pure.ts)", () => {
  test("BABYLON.MeshBuilder.CreateBox resolves to a real source file with a real signature", async () => {
    const forms = extractCallForms("use BABYLON.MeshBuilder.CreateBox(name, options, scene)");
    expect(forms.length).toBe(1);
    const live = await findLiveCall(forms[0].name, forms[0].fileHint, LIVE_ROOT!);
    expect(live).not.toBeNull();
    // The resolver must NOT land in node_modules type declarations or compiled
    // dist output — both have empty/rewritten signatures and poison drift hits.
    expect(live!.file).not.toContain("node_modules");
    expect(live!.file).toContain("src");
    expect(live!.file).toMatch(/\.ts$/);
    expect(live!.argsText.length).toBeGreaterThan(0);
  });

  test("a valid usage pattern matching the live signature promotes (no false drift)", async () => {
    const root = mkdtempSync(join(tmpdir(), "osi-real-"));
    process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
    process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
    resetState();
    const sid = "r1-promote";
    setCurrent({ sessionID: sid, callID: "C1", tool: "grep" });
    await afterTool(
      { tool: "grep", sessionID: sid, callID: "C1", args: { pattern: "CreateBox" } },
      { output: "5 matches found", metadata: {} },
    );
    setCurrent({ sessionID: sid, callID: "C2", tool: "read" });
    await afterTool(
      { tool: "read", sessionID: sid, callID: "C2", args: { filePath: "packages/dev/core/src/Meshes/meshBuilder.pure.ts" } },
      { output: "export const MeshBuilder = …", metadata: {} },
    );
    const ctx = {
      liveRoot: LIVE_ROOT!,
      evidenceCalls: evidenceCalls(sid),
      hasGateCheck: hasGateCheck(sid),
      hasEngagement: hasEngagement(sid),
    };
    setCurrent({ sessionID: sid, callID: "C3", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "pattern", scope: "babylon", content: "use BABYLON.MeshBuilder.CreateBox(name, options, scene) to create a box" },
      ctx,
    );
    expect(outcome.action).toBe("promoted");
  });

  test("shorthand usage (fewer args than the live signature) is NOT drift", async () => {
    const forms = extractCallForms("SceneLoader.ImportMesh(meshNames, rootUrl, sceneFilename)");
    expect(forms.length).toBe(1);
    const live = await findLiveCall(forms[0].name, forms[0].fileHint, LIVE_ROOT!);
    expect(live).not.toBeNull();
    // live ImportMesh has many more params — shorthand memory is a usage
    // note, not a signature claim. Only the args the memory actually states
    // must match (prefix rule); trailing omission is not drift.
    expect(sameArgs(forms[0].argsText, live!.argsText)).toBe(true);
  });

  test("a WRONG signature on a real symbol is still genuine drift", async () => {
    // Old Mesh API is CreateBox(name, size, scene); MeshBuilder uses (name, options, scene).
    const forms = extractCallForms("MeshBuilder.CreateBox(name, size, scene)");
    expect(forms.length).toBe(1);
    const live = await findLiveCall(forms[0].name, forms[0].fileHint, LIVE_ROOT!);
    expect(live).not.toBeNull();
    // `size` is not a MeshBuilder.CreateBox param — this must NOT be treated
    // as a shorthand prefix; it is a positional mismatch (real drift).
    expect(sameArgs(forms[0].argsText, live!.argsText)).toBe(false);
  });
});

describe("R2 — real-repo resolver contract sanity", () => {
  test("sameArgs is pure and prefix-only at the unit level", () => {
    expect(sameArgs("name, size", "name, size, scene")).toBe(true);
    expect(sameArgs("name, size", "name, other, scene")).toBe(false);
    expect(sameArgs("", "")).toBe(true);
    expect(sameArgs("config, opts", "config, opts")).toBe(true);
  });
});