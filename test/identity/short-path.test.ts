import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { normalizeDirPath, resolveRepo } from "../../src/identity/repokey.ts";
import { isVisibleTo } from "../../src/store/model/visibility.ts";
import { withTempStore } from "../helpers/temp-store.ts";

const store = withTempStore({ prefix: "osi-short-path-" });

test.skipIf(process.platform !== "win32")(
  "Windows short paths retain project identity and visibility of old path keys",
  () => {
    const directory = join(store.root, "long-project-directory");
    const other = join(store.root, "other-project-directory");
    mkdirSync(directory);
    mkdirSync(other);
    const long = realpathSync.native(directory);
    // Ask Windows for its actual alias, rather than guessing an 8.3 spelling.
    // Volumes without short names return the long spelling instead.
    const child = Bun.spawnSync(
      [
        process.env.ComSpec ?? "cmd.exe",
        "/d",
        "/c",
        `for %I in ("${long}") do @echo %~sI`,
      ],
      { stdout: "pipe", stderr: "pipe", windowsVerbatimArguments: true },
    );
    expect(child.exitCode).toBe(0);
    const short = child.stdout.toString().trim();
    expect(short).not.toBe("");
    expect(realpathSync.native(short)).toBe(long);
    expect(normalizeDirPath(short)).toBe(normalizeDirPath(long));
    expect(resolveRepo(short).key).toBe(resolveRepo(long).key);

    // Older Bun realpathSync retained short names when stamping path-derived keys.
    const oldKey = createHash("sha1")
      .update(short.replace(/\\/g, "/").toLowerCase())
      .digest("hex")
      .slice(0, 12);
    const oldRow = { repo: oldKey, repoPath: short };
    expect(
      isVisibleTo(oldRow, { kind: "repo", scope: resolveRepo(long) }),
    ).toBe(true);
    expect(
      isVisibleTo(oldRow, { kind: "repo", scope: resolveRepo(other) }),
    ).toBe(false);
    expect(
      isVisibleTo(
        { repo: resolveRepo(long).key, repoPath: long },
        { kind: "repo", scope: resolveRepo(short) },
      ),
    ).toBe(true);
  },
);
