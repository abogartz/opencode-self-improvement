// Store paths for the self-improvement harness. Everything lives OUTSIDE any
// repository (invariant I2): under ~/.config/opencode/memory by default, or
// under $OPENCODE_MEMORY_DIR when set (tests use this for hermetic runs).
import { homedir } from "node:os";
import { join } from "node:path";

export function memoryRoot(): string {
  return (
    process.env.OPENCODE_MEMORY_DIR ||
    join(homedir(), ".config", "opencode", "memory")
  );
}

// Where the plugin mirrors its own slash command (/repo-init). Written once at
// load (write-if-missing), so no manual setup is needed after install.
export function commandsDir(): string {
  return (
    process.env.OPENCODE_COMMANDS_DIR ||
    join(homedir(), ".config", "opencode", "commands")
  );
}

export function evidenceDir(): string {
  return join(memoryRoot(), "evidence");
}

export function snapshotDir(): string {
  return join(memoryRoot(), "snapshots");
}

export function canonicalFile(): string {
  return join(memoryRoot(), "canonical.logfmt");
}

export function deletionsFile(): string {
  return join(memoryRoot(), "deletions.logfmt");
}

export function dateStr(d: Date = new Date()): string {
  return d.toISOString().split("T")[0];
}

// Optional live-graph binary. When present the resolver cross-checks the local
// source scan against the codebase-memory-mcp file graph; when absent the local
// scan alone is authoritative (install-from-scratch requirement).
export function cbmBin(): string | undefined {
  return process.env.OPENCODE_CBM_BIN || undefined;
}
