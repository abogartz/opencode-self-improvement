// Command self-install: the plugin mirrors /repo-init into opencode's commands
// dir on load — no terminal copy step. Idempotent (never overwrites edits).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin } from "./harness.ts";
import { resetState } from "../src/state.ts";
import { ensureCommand } from "../src/command.ts";

let commandsDirPath: string;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-cmd-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  commandsDirPath = process.env.OPENCODE_COMMANDS_DIR;
  resetState();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("ensureInitCommand", () => {
  test("writes /repo-init on plugin load; content points at memory_init", async () => {
    mkdirSync(commandsDirPath, { recursive: true });
    await loadPlugin(process.cwd());
    const target = join(commandsDirPath, "repo-init.md");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("memory_init");
  });

  test("does not overwrite an existing command (write-if-missing)", async () => {
    mkdirSync(commandsDirPath, { recursive: true });
    const target = join(commandsDirPath, "repo-init.md");
    writeFileSync(target, "# user-customized\n");
    await loadPlugin(process.cwd());
    expect(readFileSync(target, "utf8")).toBe("# user-customized\n");
  });

  test("a missing command source returns null and writes no command", async () => {
    // Exercise the actual missing-source branch without changing the package.
    expect(existsSync(commandsDirPath)).toBe(false);
    expect(await ensureCommand("deliberately-absent-test-command")).toBeNull();
    expect(existsSync(commandsDirPath)).toBe(false);
  });
});
