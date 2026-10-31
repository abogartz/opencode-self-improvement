// Issue #92: the repo= field must ALWAYS be a bare token. Non-git (and
// origin-less) dirs used to stamp the raw path, which logfmt quotes when the
// path contains a space or backslash — breaking naive field extraction and
// making the key unmatchable-by-hash. Now: repo= is sha1 of the NORMALIZED
// path (separators unified, symlinks/junctions and 8.3 aliases resolved,
// case folded on case-insensitive filesystems), repoPath stays the raw
// resolved path, and pre-hash rows keep matching through repoPath.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDirPath, resolveRepo, resetSessionScopes, setRepoScope } from "../src/repokey.ts";
import { appendMemory } from "../src/memory.ts";
import { resetState } from "../src/state.ts";
import { relevantKnowledge } from "../src/inject.ts";

const gitToplevel = (dir: string): string | null => {
  try {
    const p = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir, stdout: "pipe", stderr: "ignore" });
    const out = p.stdout?.toString().trim();
    return p.exitCode === 0 && out ? out : null;
  } catch {
    return null;
  }
};

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

let root: string;
let memDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-repokey-"));
  memDir = join(root, "memory");
  process.env.OPENCODE_MEMORY_DIR = memDir;
  // This file asserts on the AMBIENT module scope: it calls setRepoScope()
  // and expects appendMemory to stamp with it, and reads through the ambient
  // reader. Both resolve the calling session FIRST when one is bound (#127),
  // so the file must own that state too — an ambient sid left behind by an
  // earlier file silently outranks setRepoScope() (#149).
  resetState();
  resetSessionScopes();
  setRepoScope(null);
});
afterEach(() => {
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const dayFile = () => join(memDir, `${new Date().toISOString().split("T")[0]}.logfmt`);

describe("non-git repo keys are bare tokens (#92)", () => {
  test("a session dir containing a space stamps repo= as an unquoted hash, repoPath stays raw", async () => {
    const projDir = mkdtempSync(join(tmpdir(), "osi-repokey Default Project "));
    try {
      setRepoScope(resolveRepo(projDir));
      await appendMemory({ type: "learning", scope: "s", content: "the build runs from a folder with a space" });
      const raw = readFileSync(dayFile(), "utf8");
      // The acceptance claim: repo= is always a bare [a-z0-9]+ token...
      expect(raw).toMatch(/repo=[a-z0-9]+( |$)/m);
      expect(raw).not.toContain('repo="');
      // ...repoPath keeps the human-readable path (quoted or not, parser-safe either way),
      // and the row round-trips through the parser with a hash key.
      const scope = resolveRepo(projDir);
      expect(raw).toContain(`repo=${scope.key}`);
      if (!gitToplevel(projDir)) {
        // Truly non-git on this machine: the key IS the normalized-path hash.
        expect(scope.key).toBe(sha1(normalizeDirPath(projDir)));
        expect(scope.key).not.toBe(projDir);
      }
    } finally {
      rmSync(projDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test("the path hash is stable across spelling: separators, trailing slash, case, aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "osi-repokey alias-"));
    try {
      const base = resolveRepo(dir).key;
      expect(base).toBe(resolveRepo(join(dir, ".")).key); // spelling via "."
      expect(base).toBe(resolveRepo(`${dir}${process.platform === "win32" ? "\\" : "/"}`).key); // trailing sep
      // Symlink/junction alias (junctions need no privileges on Windows):
      const link = join(root, "alias-link");
      let linked = false;
      try {
        symlinkSync(dir, link, process.platform === "win32" ? "junction" : "dir");
        linked = true;
      } catch {
        // filesystem refused the link (unprivileged Linux in a container) - spelling
        // variants above still pin the normalizer.
      }
      // An unavailable link can be skipped; a failed equality cannot.
      if (linked) expect(resolveRepo(link).key).toBe(base);
      if (process.platform === "win32" || process.platform === "darwin") {
        // case-insensitive filesystems must fold: same dir, other case, same key
        const flipped = resolveRepo(/[A-Z]/.test(dir) ? dir.replace(/[A-Z]/, (c) => c.toLowerCase()) : dir.replace(/[a-z]/, (c) => c.toUpperCase()));
        expect(flipped.key).toBe(base);
      }
    } finally {
      /* root cleaned by afterEach */
    }
  });

  test("rows written before the hash (repo= was the path) stay visible through repoPath", async () => {
    const projDir = mkdtempSync(join(tmpdir(), "osi-repokey legacy-"));
    const scope = { key: sha1(normalizeDirPath(projDir)), path: projDir };
    // Forge a legacy row exactly as the pre-hash code wrote it: repo= raw path.
    await appendMemory({ type: "learning", scope: "s", content: "legacy note about the old pipeline", repo: projDir, repoPath: projDir });
    setRepoScope(scope);
    const hits = await relevantKnowledge("old pipeline note", 5);
    expect(hits).toContain("legacy note about the old pipeline");
    // And new writes under the hashed scope land beside it, token-stamped.
    await appendMemory({ type: "learning", scope: "s", content: "new note about the same pipeline" });
    const raw = readFileSync(dayFile(), "utf8");
    expect(raw).toContain(`repo=${scope.key}`);
  });

  test("normalizeDirPath returns a separator-unified, trailing-slash-free path", () => {
    const dir = mkdtempSync(join(tmpdir(), "osi-repokey norm-"));
    const n = normalizeDirPath(dir);
    expect(n).not.toMatch(/\\/);
    expect(n.endsWith("/")).toBe(false); // this fixture is a child directory, never a filesystem root
    if (process.platform === "win32" || process.platform === "darwin") expect(n).toBe(n.toLowerCase());
    expect(normalizeDirPath(n + (process.platform === "win32" ? "\\" : "/"))).toBe(n);
  });
});
