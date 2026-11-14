// #254: a historical whole-path-folded key is not authority over a distinct
// lowercase sibling. Exercise real retrieval, evidence, and restore filtering.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetState } from "../src/core/state.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { evidenceFileFor } from "../src/evidence/record.ts";
import {
  rememberSessionDir,
  resetSessionScopes,
  resolveRepo,
  setRepoScope,
} from "../src/identity/repokey.ts";
import { relevantKnowledge } from "../src/recall/relevant.ts";
import { appendMemory } from "../src/store/files/append.ts";
import {
  ADMIN_READER,
  evidenceVisibleTo,
  isVisibleTo,
  lineVisibleTo,
  type Reader,
} from "../src/store/model/visibility.ts";
import { loadPlugin } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

const hash = (s: string) =>
  createHash("sha1").update(s).digest("hex").slice(0, 12);
const legacyKey = (path: string) =>
  hash(path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
// A lowercase canonical ancestor is essential to reproduce the collision.
const parent = process.platform === "win32" ? tmpdir() : "/tmp";
const oracle = mkdtempSync(join(parent, "osi254-oracle-"));
let foldsCase: boolean;
try {
  writeFileSync(join(oracle, "case-probe"), "x");
  foldsCase = existsSync(join(oracle, "CASE-PROBE"));
} finally {
  removeStore(oracle);
}

let root: string;
let oldMemoryDir: string | undefined;
let oldCommandsDir: string | undefined;
beforeEach(() => {
  root = join(parent, `osi254-${randomUUID()}`);
  mkdirSync(root);
  root = realpathSync(root);
  oldMemoryDir = process.env.OPENCODE_MEMORY_DIR;
  oldCommandsDir = process.env.OPENCODE_COMMANDS_DIR;
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
});
afterEach(() => {
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  if (oldMemoryDir === undefined) delete process.env.OPENCODE_MEMORY_DIR;
  else process.env.OPENCODE_MEMORY_DIR = oldMemoryDir;
  if (oldCommandsDir === undefined) delete process.env.OPENCODE_COMMANDS_DIR;
  else process.env.OPENCODE_COMMANDS_DIR = oldCommandsDir;
  removeStore(root);
});

function siblings() {
  const upper = join(root, "Foo"),
    lower = join(root, "foo");
  mkdirSync(upper);
  mkdirSync(lower);
  const owner = resolveRepo(upper),
    other = resolveRepo(lower);
  const stamp = { repo: legacyKey(owner.path), repoPath: owner.path };
  expect(owner.key).not.toBe(other.key);
  expect(stamp.repo).toBe(other.key); // prove this fixture reaches the key collision
  return { upper, lower, owner, other, stamp };
}

describe.skipIf(foldsCase)(
  "legacy folded keys on case-sensitive volumes (#254)",
  () => {
    test("owner retrieval survives; the lowercase sibling cannot retrieve the row", async () => {
      const { owner, other, stamp } = siblings();
      const content =
        "private upper project legacy marker for the staging pipeline";
      await appendMemory({ type: "learning", scope: "s", content, ...stamp });
      setRepoScope(owner);
      expect(await relevantKnowledge(content, 5)).toContain(content);
      setRepoScope(other);
      expect(await relevantKnowledge(content, 5)).not.toContain(content);
    });

    test("memory_evidence keeps a legacy stamped event with its owner", async () => {
      const { upper, lower, stamp } = siblings();
      const plugin = await loadPlugin(upper);
      try {
        rememberSessionDir("owner", upper);
        rememberSessionDir("sibling", lower);
        const file = evidenceFileFor();
        if (!file)
          throw new Error(
            "fixture evidence date must resolve inside the temporary store",
          );
        writeFileSync(
          file,
          `${formatLine({ ev: "legacy_probe", sid: "writer", ...stamp })}\n`,
        );
        const own = await plugin.tools.memory_evidence.execute(
          { ev: "legacy_probe" },
          { sessionID: "owner" },
        );
        expect(own.content).toContain("ev=legacy_probe");
        const foreign = await plugin.tools.memory_evidence.execute(
          { ev: "legacy_probe" },
          { sessionID: "sibling" },
        );
        expect(foreign.content).toBe("No evidence");
      } finally {
        await plugin.cleanup();
      }
    });

    test("restore's raw-line authorization rejects the colliding sibling", () => {
      const { owner, other, stamp } = siblings();
      const line = formatLine({ ts: "2026-01-01T00:00:00.000Z", ...stamp });
      expect(lineVisibleTo(line, { kind: "repo", scope: owner })).toBe(true);
      expect(lineVisibleTo(line, { kind: "repo", scope: other })).toBe(false);
      expect(lineVisibleTo(line, ADMIN_READER)).toBe(true);
    });

    test("a symlink alias of the legacy owner retains access to rows and evidence", () => {
      const { upper, stamp } = siblings();
      const alias = join(root, "owner-alias");
      symlinkSync(
        upper,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const reader: Reader = { kind: "repo", scope: resolveRepo(alias) };
      expect(isVisibleTo(stamp, reader)).toBe(true);
      expect(evidenceVisibleTo(stamp, reader)).toBe(true);
    });

    test("a legacy stamp whose stored path is an alias still excludes the sibling", () => {
      const { upper, owner, other, stamp } = siblings();
      const alias = join(root, "stored-alias");
      symlinkSync(
        upper,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const aliased = { ...stamp, repoPath: alias };
      expect(isVisibleTo(aliased, { kind: "repo", scope: owner })).toBe(true);
      expect(evidenceVisibleTo(aliased, { kind: "repo", scope: owner })).toBe(
        true,
      );
      expect(isVisibleTo(aliased, { kind: "repo", scope: other })).toBe(false);
      expect(evidenceVisibleTo(aliased, { kind: "repo", scope: other })).toBe(
        false,
      );
    });
  },
);

test("remote-derived keys still share rows and evidence between real clone directories", async () => {
  const dirs = [join(root, "clone-one"), join(root, "clone-two")];
  for (const dir of dirs) {
    mkdirSync(dir);
    for (const args of [
      ["init", "--quiet"],
      ["remote", "add", "origin", "https://github.com/example/shared.git"],
    ]) {
      const git = Bun.spawnSync(["git", ...args], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(git.exitCode).toBe(0);
    }
  }
  const owner = resolveRepo(dirs[0]),
    clone = resolveRepo(dirs[1]);
  expect(owner.key).toBe(clone.key);
  const stamp = { repo: owner.key, repoPath: owner.path };
  const content =
    "shared origin project deploys through the common staging pipeline";
  await appendMemory({ type: "learning", scope: "s", content, ...stamp });
  setRepoScope(clone);
  expect(await relevantKnowledge(content, 5)).toContain(content);
  expect(evidenceVisibleTo(stamp, { kind: "repo", scope: clone })).toBe(true);
});

test("case-insensitive spellings of a legacy owner retain row and evidence access", () => {
  const dir = join(root, "MixedCase");
  mkdirSync(dir);
  const stamp = { repo: legacyKey(dir), repoPath: dir };
  const reader: Reader = {
    kind: "repo",
    scope: resolveRepo(foldsCase ? dir.toUpperCase() : dir),
  };
  expect(isVisibleTo(stamp, reader)).toBe(true);
  expect(evidenceVisibleTo(stamp, reader)).toBe(true);
});

test("global, unstamped, admin, and session-private evidence rules stay intact", () => {
  const reader: Reader = {
    kind: "repo",
    scope: { key: "unrelated", path: root },
  };
  expect(isVisibleTo({}, reader)).toBe(true);
  expect(isVisibleTo({ repo: "global" }, reader)).toBe(true);
  expect(isVisibleTo({ repo: "private" }, { kind: "global-only" })).toBe(false);
  expect(evidenceVisibleTo({ repo: "global" }, reader)).toBe(true);
  expect(evidenceVisibleTo({ sid: "private" }, reader, "private")).toBe(true);
  expect(evidenceVisibleTo({ sid: "private" }, reader, "other")).toBe(false);
  expect(evidenceVisibleTo({ repo: "private" }, ADMIN_READER)).toBe(true);
});

test("a legacy key without its path retains the documented key-only compatibility", () => {
  const dir = join(root, "MixedCase");
  mkdirSync(dir);
  const stamp = { repo: legacyKey(dir) };
  const reader: Reader = {
    kind: "repo",
    scope: { key: stamp.repo, path: join(root, "elsewhere") },
  };
  expect(isVisibleTo(stamp, reader)).toBe(true);
  expect(evidenceVisibleTo(stamp, reader)).toBe(true);
});
