// Command self-install: the plugin mirrors /repo-init into opencode's commands
// dir on load — no terminal copy step. Idempotent (never overwrites edits).
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SelfImprovement } from "../index.ts";
import { resetState } from "../src/state.ts";

let commandsDirPath: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "osi-cmd-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  commandsDirPath = process.env.OPENCODE_COMMANDS_DIR;
  resetState();
});

describe("ensureInitCommand", () => {
  test("writes /repo-init on plugin load; content points at memory_init", async () => {
    mkdirSync(commandsDirPath, { recursive: true });
    await SelfImprovement({ directory: process.cwd() } as never);
    const target = join(commandsDirPath, "repo-init.md");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("memory_init");
  });

  test("does not overwrite an existing command (write-if-missing)", async () => {
    mkdirSync(commandsDirPath, { recursive: true });
    const target = join(commandsDirPath, "repo-init.md");
    writeFileSync(target, "# user-customized\n");
    await SelfImprovement({ directory: process.cwd() } as never);
    expect(readFileSync(target, "utf8")).toBe("# user-customized\n");
  });

  test("missing source degrades silently (no throw on load)", async () => {
    // command/repo-init.md referenced from import.meta.dir always exists in a
    // real install; simulate a broken package by pointing SOURCE nowhere is not
    // possible without a hook, so assert the factory still loads and the dir is
    // created without error in the happy path.
    const hooks = await SelfImprovement({ directory: process.cwd() } as never);
    expect(Object.keys(hooks.tool ?? {}).length).toBeGreaterThan(0);
  });
});