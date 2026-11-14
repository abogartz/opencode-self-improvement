// Issue #92: the repo= field must ALWAYS be a bare token. Non-git (and
// origin-less) dirs used to stamp the raw path, which logfmt quotes when the
// path contains a space or backslash — breaking naive field extraction and
// making the key unmatchable-by-hash. Now: repo= is sha1 of the NORMALIZED
// path (separators unified, symlinks/junctions and 8.3 aliases resolved,
// case folded on case-insensitive filesystems), repoPath stays the raw
// resolved path, and pre-hash rows keep matching through repoPath.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCaseInsensitivePath,
  normalizeDirPath,
  resolveRepo,
  resetSessionScopes,
  setRepoScope,
} from "../src/identity/repokey.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { resetState } from "../src/core/state.ts";
import { relevantKnowledge } from "../src/recall/relevant.ts";
import { dayFile } from "./helpers/logfmt.ts";
import { removeStore } from "./helpers/remove-store.ts";

const gitToplevel = (dir: string): string | null => {
  try {
    const p = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = p.stdout?.toString().trim();
    return p.exitCode === 0 && out ? out : null;
  } catch {
    return null;
  }
};

const sha1 = (s: string) =>
  createHash("sha1").update(s).digest("hex").slice(0, 12);

// Independent ground truth for the volume under test (#109): write a lowercase
// file and ask whether the UPPERCASE spelling names an existing file. A
// case-insensitive volume says yes; a case-sensitive one says no. Deliberately
// never calls the probe under test.
const volumeFoldsCase = (dir: string): boolean => {
  const name = "osi-case-oracle";
  const a = join(dir, name);
  try {
    writeFileSync(a, "x");
    return existsSync(join(dir, name.toUpperCase()));
  } finally {
    rmSync(a, { force: true });
  }
};

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
  removeStore(root);
});

describe("non-git repo keys are bare tokens (#92)", () => {
  test("a session dir containing a space stamps repo= as an unquoted hash, repoPath stays raw", async () => {
    const projDir = mkdtempSync(join(tmpdir(), "osi-repokey Default Project "));
    try {
      setRepoScope(resolveRepo(projDir));
      await appendMemory({
        type: "learning",
        scope: "s",
        content: "the build runs from a folder with a space",
      });
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
      removeStore(projDir);
    }
  });

  test("the path hash is stable across spelling: separators, trailing slash, case, aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "osi-repokey alias-"));
    try {
      const base = resolveRepo(dir).key;
      expect(base).toBe(resolveRepo(join(dir, ".")).key); // spelling via "."
      expect(base).toBe(
        resolveRepo(`${dir}${process.platform === "win32" ? "\\" : "/"}`).key,
      ); // trailing sep
      // Symlink/junction alias (junctions need no privileges on Windows):
      const link = join(root, "alias-link");
      let linked = false;
      try {
        symlinkSync(
          dir,
          link,
          process.platform === "win32" ? "junction" : "dir",
        );
        linked = true;
      } catch {
        // filesystem refused the link (unprivileged Linux in a container) - spelling
        // variants above still pin the normalizer.
      }
      // An unavailable link can be skipped; a failed equality cannot.
      if (linked) expect(resolveRepo(link).key).toBe(base);
      const flippedPath = /[A-Z]/.test(dir)
        ? dir.replace(/[A-Z]/, (c) => c.toLowerCase())
        : dir.replace(/[a-z]/, (c) => c.toUpperCase());
      if (volumeFoldsCase(dir)) {
        // case-insensitive filesystems must fold: same dir, other case, same key
        expect(resolveRepo(flippedPath).key).toBe(base);
      }
      // The case-SENSITIVE direction needs both dirs to exist (a missing
      // spelling only ever hits the undecided fallback); the dedicated
      // "dirs differing only by case" test below pins that with real dirs.
    } finally {
      /* root cleaned by afterEach */
    }
  });

  test("rows written before the hash (repo= was the path) stay visible through repoPath", async () => {
    const projDir = mkdtempSync(join(tmpdir(), "osi-repokey legacy-"));
    const scope = { key: sha1(normalizeDirPath(projDir)), path: projDir };
    // Forge a legacy row exactly as the pre-hash code wrote it: repo= raw path.
    await appendMemory({
      type: "learning",
      scope: "s",
      content: "legacy note about the old pipeline",
      repo: projDir,
      repoPath: projDir,
    });
    setRepoScope(scope);
    const hits = await relevantKnowledge("old pipeline note", 5);
    expect(hits).toContain("legacy note about the old pipeline");
    // And new writes under the hashed scope land beside it, token-stamped.
    await appendMemory({
      type: "learning",
      scope: "s",
      content: "new note about the same pipeline",
    });
    const raw = readFileSync(dayFile(), "utf8");
    expect(raw).toContain(`repo=${scope.key}`);
  });

  test("normalizeDirPath returns a separator-unified, trailing-slash-free path", () => {
    const dir = mkdtempSync(join(tmpdir(), "osi-repokey norm-"));
    const n = normalizeDirPath(dir);
    expect(n).not.toMatch(/\\/);
    expect(n.endsWith("/")).toBe(false); // this fixture is a child directory, never a filesystem root
    if (volumeFoldsCase(dir)) expect(n).toBe(n.toLowerCase());
    expect(
      normalizeDirPath(n + (process.platform === "win32" ? "\\" : "/")),
    ).toBe(n);
  });
});

describe("case folding follows the volume, not the platform (#109)", () => {
  test("isCaseInsensitivePath agrees with the filesystem's own name-matching", () => {
    const dir = mkdtempSync(join(tmpdir(), "osi-repokey-109-probe-"));
    try {
      expect(isCaseInsensitivePath(dir)).toBe(volumeFoldsCase(dir));
      // A missing path is decided from the nearest existing component.
      expect(isCaseInsensitivePath(join(dir, "gone", "deeper"))).toBe(
        volumeFoldsCase(dir),
      );
    } finally {
      removeStore(dir);
    }
  });

  test("normalizeDirPath folds exactly when the volume folds", () => {
    const base = mkdtempSync(join(tmpdir(), "osi-repokey-109-fold-"));
    const named = join(base, "MixedCase"); // guarantees cased characters to fold
    mkdirSync(named);
    try {
      const n = normalizeDirPath(named);
      if (volumeFoldsCase(base)) expect(n).toBe(n.toLowerCase());
      else expect(n).toContain("MixedCase");
    } finally {
      removeStore(base);
    }
  });

  test("dirs differing only by case share a key only where the volume folds them", () => {
    const base = mkdtempSync(join(tmpdir(), "osi-repokey-109-two-"));
    const upper = join(base, "Proj");
    const lower = join(base, "proj");
    mkdirSync(upper);
    let caseSensitive = false;
    try {
      mkdirSync(lower);
      caseSensitive = true; // both spellings exist: the volume does not fold
    } catch {
      // EEXIST: the folded spelling names the same directory
    }
    try {
      const hi = resolveRepo(upper).key;
      const lo = resolveRepo(lower).key;
      if (caseSensitive) expect(lo).not.toBe(hi);
      else expect(lo).toBe(hi);
    } finally {
      removeStore(base);
    }
  });

  test("a path with nothing existing falls back to the platform rule", () => {
    const gone = "/Osi109NoSuchVolume/DefinitelyMissing";
    expect(isCaseInsensitivePath(gone)).toBe(null);
    const folded =
      process.platform === "win32" || process.platform === "darwin";
    expect(normalizeDirPath(gone)).toBe(folded ? gone.toLowerCase() : gone);
  });

  test("rows stamped under the old platform fold stay visible through repoPath", async () => {
    const base = mkdtempSync(join(tmpdir(), "osi-repokey-109-compat-"));
    const projDir = join(base, "CompatProj"); // cased, so the old fold really differed
    mkdirSync(projDir);
    try {
      // Exactly what the pre-fix normalizer stamped for this path on ANY
      // platform: the lowercased spelling as the hash input.
      const oldKey = sha1(
        projDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(),
      );
      await appendMemory({
        type: "learning",
        scope: "s",
        content: "note stamped under the old platform fold",
        repo: oldKey,
        repoPath: projDir,
      });
      setRepoScope(resolveRepo(projDir));
      const hits = await relevantKnowledge("old fold platform stamp", 5);
      expect(hits).toContain("note stamped under the old platform fold");
    } finally {
      removeStore(base);
    }
  });
});

// These regressions require two distinct case-variant directories. Decide
// from an independent filesystem oracle, not the implementation under test.
// On POSIX use /tmp so the canonical ancestor can be all lowercase; an
// uppercase random ancestor can hide a whole-path-lowercasing collision.
const aliasTestParent = process.platform === "win32" ? tmpdir() : "/tmp";
const aliasOracle = mkdtempSync(join(aliasTestParent, "osi250-oracle-"));
let aliasVolumeFolds: boolean;
try {
  aliasVolumeFolds = volumeFoldsCase(aliasOracle);
} finally {
  removeStore(aliasOracle);
}

describe.skipIf(aliasVolumeFolds)(
  "case-variant symlinks do not authorize folding (#250 F1)",
  () => {
    test.each(["", "123"])(
      "keeps sibling memories private with an uncased suffix '%s'",
      async (suffix) => {
        const base = join(aliasTestParent, `osi250-${randomUUID()}`);
        mkdirSync(base);
        const upper = join(base, "Foo");
        const lower = join(base, "foo");
        const alias = join(base, "FoO");
        mkdirSync(upper);
        mkdirSync(lower);
        try {
          symlinkSync(
            upper,
            alias,
            process.platform === "win32" ? "junction" : "dir",
          );
          if (suffix) {
            mkdirSync(join(upper, suffix));
            mkdirSync(join(lower, suffix));
          }
          const owner = resolveRepo(join(upper, suffix));
          const other = resolveRepo(join(lower, suffix));
          expect(isCaseInsensitivePath(join(upper, suffix))).toBe(false);
          expect(owner.key).not.toBe(other.key);
          // An actual alias still resolves to its target: rejection of the false
          // case probe must not break canonicalization of the input path itself.
          expect(resolveRepo(join(alias, suffix)).key).toBe(owner.key);
          const content =
            "the private widget pipeline requires an isolated staging queue";
          await appendMemory({
            type: "learning",
            scope: "s",
            content,
            repo: owner.key,
            repoPath: owner.path,
          });
          setRepoScope(owner);
          expect(await relevantKnowledge(content, 5)).toContain(content);
          setRepoScope(other);
          expect(await relevantKnowledge(content, 5)).not.toContain(content);
        } finally {
          removeStore(base);
        }
      },
    );
  },
);
