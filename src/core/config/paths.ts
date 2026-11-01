// paths — split from src/config.ts (#168 domain restructure). Declaration bodies are unchanged.
// Store paths for the self-improvement harness. Everything lives OUTSIDE any
// repository: under ~/.config/opencode/memory by default, or
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

// The only place memory_export may write (src/containment.ts). An export is a
// copy of the live store, so it is store data and lives inside the store.
export function exportsDir(): string {
  return join(memoryRoot(), "exports");
}

// Escape hatch for out-of-band migrations only: when truthy, memory_export and
// memory_import accept paths anywhere on the filesystem instead of confining
// themselves to the store. Read from the plugin process's own environment at
// call time, so a model cannot grant it to itself through a tool argument; the
// default is closed. See src/containment.ts.
export function allowOutsideStorePaths(): boolean {
  const raw = process.env.OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS;
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function canonicalFile(): string {
  return join(memoryRoot(), "canonical.logfmt");
}

// The use ledger (src/hits.ts). Lives in the store root beside the day files
// but is NOT a memory file: memory.ts's RESERVED set keeps it out of loadAll().
export const HITS_FILENAME = "hits.logfmt";

export function deletionsFile(): string {
  return join(memoryRoot(), "deletions.logfmt");
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
