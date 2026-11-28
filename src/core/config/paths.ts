// paths — split from src/config.ts. Declaration bodies are unchanged.
// Store paths for the self-improvement harness. Everything lives OUTSIDE any
// repository: under ~/.config/opencode/memory by default, or
// under $OPENCODE_MEMORY_DIR when set (tests use this for hermetic runs).
import { homedir } from "node:os";
import { join } from "node:path";
import { tightenDirectory } from "../permissions.ts";

export function memoryRoot({ readOnly = false } = {}): string {
  const root =
    process.env.OPENCODE_MEMORY_DIR ||
    join(homedir(), ".config", "opencode", "memory");
  // Only the benchmark replay should request readOnly. Runtime callers
  // must keep permission tightening enabled, including ordinary reads.
  if (!readOnly) tightenDirectory(root);
  return root;
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

// The use ledger (src/telemetry/ledger.ts). Lives in the store root beside the day files
// but is NOT a memory file: memory.ts's RESERVED set keeps it out of loadAll().
export const HITS_FILENAME = "hits.logfmt";

export function deletionsFile(): string {
  return join(memoryRoot(), "deletions.logfmt");
}
