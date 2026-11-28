import { afterEach, beforeEach } from "bun:test";
import { lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { resetState } from "../../src/core/state.ts";
import { removeStoreAsync } from "./remove-store.ts";

/**
 * Register an isolated store for each test in the current describe scope.
 * Read paths inside hooks/tests (`const store = withTempStore({ prefix: "osi-example-" })`);
 * do not destructure them at suite declaration time. Register this before local
 * setup. Put asynchronous resource cleanup in a nested describe so it completes
 * before the fixture's outer teardown removes the store.
 *
 * Both memory and command output are confined to the fixture. Prior environment
 * values (including absent ones) are restored even if cleanup refuses or fails.
 */
export function withTempStore({
  prefix = "osi-test-",
}: {
  prefix?: string;
} = {}): {
  readonly root: string;
  readonly memoryDir: string;
} {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(prefix)) {
    throw new Error(
      "withTempStore prefix must be a nonempty filename prefix without path separators",
    );
  }
  let active:
    | {
        root: string;
        memoryDir: string;
        tempParent: string;
        memory?: string;
        commands?: string;
      }
    | undefined;

  function assertRoot(root: string, tempParent: string): void {
    const canonical = realpathSync(root);
    const below = relative(tempParent, canonical);
    if (
      !below ||
      below === ".." ||
      below.startsWith(`..${sep}`) ||
      isAbsolute(below) ||
      lstatSync(root).isSymbolicLink() ||
      canonical !== root
    ) {
      throw new Error(
        "withTempStore: refusing cleanup of a root outside its original temporary directory",
      );
    }
  }

  beforeEach(() => {
    const tempParent = realpathSync(tmpdir());
    const root = mkdtempSync(join(tempParent, prefix));
    assertRoot(root, tempParent);
    active = {
      root,
      memoryDir: join(root, "memory"),
      tempParent,
      memory: process.env.OPENCODE_MEMORY_DIR,
      commands: process.env.OPENCODE_COMMANDS_DIR,
    };
    process.env.OPENCODE_MEMORY_DIR = active.memoryDir;
    process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
    resetState();
  });
  afterEach(async () => {
    const state = active;
    if (!state) return;
    try {
      try {
        lstatSync(state.root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      // Re-check the owned root, never a test-modified environment variable.
      assertRoot(state.root, state.tempParent);
      // Awaited, so a store-lock section the test left pending gets its turn
      // and its connection can be closed before the delete. A synchronous
      // teardown here would hold the loop, watch that section stall, and leave
      // the directory behind on Windows.
      await removeStoreAsync(state.root);
    } finally {
      if (state.memory === undefined) delete process.env.OPENCODE_MEMORY_DIR;
      else process.env.OPENCODE_MEMORY_DIR = state.memory;
      if (state.commands === undefined)
        delete process.env.OPENCODE_COMMANDS_DIR;
      else process.env.OPENCODE_COMMANDS_DIR = state.commands;
      resetState();
      active = undefined;
    }
  });
  function current() {
    if (!active)
      throw new Error("withTempStore paths are available only during a test");
    return active;
  }
  return {
    get root() {
      return current().root;
    },
    get memoryDir() {
      return current().memoryDir;
    },
  };
}
