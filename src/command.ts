// Self-installs the /repo-init slash command as part of plugin load, so users
// never run a terminal command to set up init. The command markdown ships in
// the package (command/repo-init.md) and is mirrored idempotently
// (write-if-missing; never overwrites a user's edits). Failures are swallowed —
// a missing command degrades to "ask the model to call memory_init".
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandsDir } from "./config.ts";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "command", "repo-init.md");

export async function ensureInitCommand(): Promise<string | null> {
  try {
    const target = join(commandsDir(), "repo-init.md");
    if (existsSync(target)) return null;
    const text = await Bun.file(SOURCE).text();
    await mkdir(commandsDir(), { recursive: true });
    await Bun.write(target, text);
    return target;
  } catch {
    return null;
  }
}