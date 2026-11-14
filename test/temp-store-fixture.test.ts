// Exercise fixture hooks in separate real Bun test runs. A failure or unsafe
// root must not leave the next test pointed at a user's store (#226).
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { withTempStore } from "./harness.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "osi-fixture-parent-"));
});
afterEach(() => {
  const report = join(root, "report.json");
  if (existsSync(report)) {
    const { roots } = JSON.parse(readFileSync(report, "utf8")) as {
      roots: string[];
    };
    for (const childRoot of roots) {
      // Only clean the precisely named, temporary roots this child reported.
      if (
        !childRoot.startsWith(`${realpathSync(tmpdir())}${sep}`) ||
        !basename(childRoot).startsWith("osi-fixture-child-")
      ) {
        throw new Error("unsafe child fixture cleanup path");
      }
      try {
        if (lstatSync(childRoot).isSymbolicLink()) unlinkSync(childRoot);
        else removeStore(childRoot);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
  removeStore(root);
});

function runFixture(mode: string, environment = "existing") {
  const file = join(root, "fixture.test.ts");
  const harness = pathToFileURL(join(import.meta.dir, "harness.ts")).href;
  // The generated fixture lives in a temp directory, so it imports the helper
  // by absolute URL, exactly like the harness and the append module.
  const removeStoreMod = pathToFileURL(
    join(import.meta.dir, "helpers", "remove-store.ts"),
  ).href;
  const state = pathToFileURL(
    join(import.meta.dir, "..", "src/core/state.ts"),
  ).href;
  const append = pathToFileURL(
    join(import.meta.dir, "..", "src/store/files/append.ts"),
  ).href;
  writeFileSync(
    file,
    `
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempStore } from ${JSON.stringify(harness)};
import { removeStore } from ${JSON.stringify(removeStoreMod)};
import { authoredFor, getCurrent, noteAuthored, setCurrent } from ${JSON.stringify(state)};
import { appendMemory } from ${JSON.stringify(append)};

const mode = process.env.OSI_FIXTURE_MODE;
const oldMemory = process.env.OPENCODE_MEMORY_DIR;
const oldCommands = process.env.OPENCODE_COMMANDS_DIR;
const roots = [];
let resourceCleanup = 0;
// Deliberately dirty state BEFORE the fixture's setup: the fixture must reset
// it even when the repository's global afterEach preload is also active.
beforeEach(() => { setCurrent({ sessionID: "dirty" }); noteAuthored("dirty", "old-row"); });
const store = withTempStore({ prefix: "osi-fixture-child-" });
expect(() => store.root).toThrow("only during a test");
afterAll(() => {
  const restored = process.env.OPENCODE_MEMORY_DIR === oldMemory && process.env.OPENCODE_COMMANDS_DIR === oldCommands;
  let inactive = false;
  try { store.memoryDir; } catch { inactive = true; }
  writeFileSync(process.env.OSI_FIXTURE_REPORT, JSON.stringify({ roots, restored, inactive, resourceCleanup, cleaned: roots.every((p) => !existsSync(p)) }));
  expect(restored).toBe(true);
  expect(inactive).toBe(true);
  if (mode !== "redirect") expect(roots.every((p) => !existsSync(p))).toBe(true);
});
describe("resources finish before outer fixture cleanup", () => {
  afterEach(async () => {
    if (mode === "redirect") return;
    await Promise.resolve();
    writeFileSync(join(store.root, "resource-cleanup"), "finished");
    resourceCleanup++;
  });
  test("isolates real writes and restores a test-modified environment", async () => {
    roots.push(store.root);
    writeFileSync(process.env.OSI_FIXTURE_REPORT, JSON.stringify({ roots }));
    expect(process.env.OPENCODE_MEMORY_DIR).toBe(store.memoryDir);
    expect(process.env.OPENCODE_COMMANDS_DIR).toBe(join(store.root, "commands"));
    expect(getCurrent().sid).toBe("?");
    expect(authoredFor("dirty").size).toBe(0);
    if (mode === "redirect") {
      removeStore(store.root);
      symlinkSync(process.env.OSI_FIXTURE_TARGET, store.root, process.platform === "win32" ? "junction" : "dir");
      return;
    }
    await appendMemory({ type: "learning", scope: "fixture", content: "a real memory isolated inside the fixture" });
    expect(existsSync(store.memoryDir)).toBe(true);
    process.env.OPENCODE_MEMORY_DIR = join(store.root, "changed-by-test");
    process.env.OPENCODE_COMMANDS_DIR = join(store.root, "also-changed");
    if (mode === "failure") expect("intentional failing test").toBe("success");
  });
  if (mode === "normal") test("the next test gets a fresh directory and state", () => {
    expect(existsSync(roots[0])).toBe(false);
    expect(store.root).not.toBe(roots[0]);
    roots.push(store.root);
    expect(getCurrent().sid).toBe("?");
    expect(authoredFor("dirty").size).toBe(0);
    expect(existsSync(store.memoryDir)).toBe(false);
  });
});
`,
  );
  const env: Record<string, string | undefined> = { ...process.env };
  if (environment === "absent") {
    delete env.OPENCODE_MEMORY_DIR;
    delete env.OPENCODE_COMMANDS_DIR;
  } else {
    env.OPENCODE_MEMORY_DIR =
      environment === "empty" ? "" : join(root, "original-memory");
    env.OPENCODE_COMMANDS_DIR =
      environment === "empty" ? "" : join(root, "original-commands");
  }
  env.OSI_FIXTURE_MODE = mode;
  env.OSI_FIXTURE_REPORT = join(root, "report.json");
  env.OSI_FIXTURE_TARGET = join(root, "untouched");
  // A separate owned target lets the guard's negative control prove that a
  // substituted fixture root never deletes somebody else's directory.
  if (mode === "redirect") {
    const target = env.OSI_FIXTURE_TARGET;
    // The parent owns this directory; it is never the child's fixture root.
    mkdirSync(target);
    writeFileSync(join(target, "sentinel"), "keep me");
  }
  const child = Bun.spawnSync([process.execPath, "test", file], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const report = JSON.parse(
    readFileSync(join(root, "report.json"), "utf8"),
  ) as {
    roots: string[];
    restored: boolean;
    inactive: boolean;
    resourceCleanup: number;
    cleaned: boolean;
  };
  return { child, report };
}

test.each(["existing", "absent", "empty"])(
  "fresh paths, cleanup and exact environment restoration (%s)",
  (environment) => {
    const { child, report } = runFixture("normal", environment);
    expect(child.stderr.toString()).not.toContain("(fail)");
    expect(child.exitCode).toBe(0);
    expect(report.cleaned).toBe(true);
    expect(report.restored).toBe(true);
    expect(report.inactive).toBe(true);
    expect(report.resourceCleanup).toBe(2);
    expect(report.roots).toHaveLength(2);
    expect(new Set(report.roots).size).toBe(2);
    expect(existsSync(join(root, "original-memory"))).toBe(false);
  },
);

test("a failing test still cleans its store and restores its environment", () => {
  const { child, report } = runFixture("failure");
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("intentional failing test");
  expect(report.cleaned).toBe(true);
  expect(report.restored).toBe(true);
  expect(report.inactive).toBe(true);
  expect(report.resourceCleanup).toBe(1);
});

test("cleanup refuses a redirected root and preserves the external target", () => {
  const { child, report } = runFixture("redirect");
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("refusing cleanup");
  expect(readFileSync(join(root, "untouched", "sentinel"), "utf8")).toBe(
    "keep me",
  );
  expect(report.restored).toBe(true);
  expect(report.inactive).toBe(true);
});

test.each([
  "",
  "..",
  "../escape",
  "nested/path",
  "nested\\path",
  "C:\\outside",
  "/outside",
])("rejects unsafe prefix %j before registering hooks", (prefix) => {
  expect(() => withTempStore({ prefix })).toThrow("prefix");
});
