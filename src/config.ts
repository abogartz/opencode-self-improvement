// Store paths for the self-improvement harness. Everything lives OUTSIDE any
// repository (invariant I2): under ~/.config/opencode/memory by default, or
// under $OPENCODE_MEMORY_DIR when set (tests use this for hermetic runs).
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
// Discovery order: OPENCODE_CBM_BIN override, an already-installed global on
// PATH (matches a running MCP session's build), then the pinned npm copy
// (codebase-memory-mcp is an optionalDependency of this package).
export function cbmBin(): string | undefined {
  if (process.env.OPENCODE_CBM_BIN) return process.env.OPENCODE_CBM_BIN;
  if (Bun.which("codebase-memory-mcp")) return undefined;
  try {
    const resolved = import.meta.resolve("codebase-memory-mcp/bin.js");
    if (resolved.startsWith("file://")) return fileURLToPath(resolved);
  } catch {
    // optional graph dependency not installed; PATH lookup still applies
  }
  return undefined;
}
