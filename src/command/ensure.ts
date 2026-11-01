// Self-installs the plugin's slash commands as part of plugin load, so users
// never run a terminal command to set up. Command markdown ships in the
// package (command/<name>.md) and is mirrored idempotently
// (write-if-missing; never overwrites a user's edits). Failures are swallowed —
// a missing command degrades to "ask the model to call the tool".
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandsDir } from "../core/config/paths.ts";

const PKG_COMMANDS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "command");

export async function ensureCommand(name: string): Promise<string | null> {
  try {
    const target = join(commandsDir(), `${name}.md`);
    if (existsSync(target)) return null;
    const text = await Bun.file(join(PKG_COMMANDS, `${name}.md`)).text();
    await mkdir(commandsDir(), { recursive: true });
    await Bun.write(target, text);
    return target;
  } catch {
    return null;
  }
}

export async function ensureInitCommand(): Promise<string | null> {
  return ensureCommand("repo-init");
}

// /memory-report: the chat-client parity for the terminal /memory panel
// (drives the memory_status tool). Terminal users with the TUI half get the
// live panel via /memory instead; both are documented in the README.
export async function ensureMemoryReportCommand(): Promise<string | null> {
  return ensureCommand("memory-report");
}
