// load — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
// Durable memory store engine. Reproduces the opencode-memory logfmt format
// (MIT, github.com/shuans/opencode-memory; license retained under
// vendor/opencode-memory/LICENSE) and extends it with the fields the write-gate
// needs: supersession markers, snapshots and audited deletion.
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { HITS_FILENAME, memoryRoot } from "../../core/config/paths.ts";
import { parseLine } from "../../core/logfmt/format.ts"
import { readLines } from "../../core/logfmt/read.ts";
import { blockedTs } from "../blocklist.ts";
import { ISO_TS_RE, type Memory, malformedWarnedFiles } from "../model/memory.ts";
import { type Reader, isVisibleTo, readerForAmbient } from "../model/visibility.ts";

const RESERVED = new Set([
  "deletions.logfmt",
  "deleted.logfmt",
  "canonical.logfmt",
  "blocklist.logfmt",
  // Value-keyed rejection tombstones (#35). Hashes only, never prose — and it
  // must never be ingested as a row, exported, or restored by undo.
  "rejected.logfmt",
  // The use ledger (src/hits.ts): telemetry, not memory. A hit line must never
  // be able to become a row — or to be superseded, exported, or injected.
  HITS_FILENAME,
]);

let malformedRows = 0;

/** Rows skipped as malformed by the most recent store read (approximate, in-process). */
export function malformedCount(): number {
  return malformedRows;
}

export function toMemory(fields: Record<string, unknown>, file: string, index: number): Memory | null {
  const ts = fields.ts;
  const type = fields.type;
  const scope = fields.scope;
  if (typeof ts !== "string" || typeof type !== "string") return null;
  if (typeof scope !== "string") return null;
  if (!ISO_TS_RE.test(ts) || Number.isNaN(Date.parse(ts))) {
    malformedRows++;
    if (!malformedWarnedFiles.has(file)) {
      malformedWarnedFiles.add(file);
      console.warn(
        `[memory] malformed row skipped in ${file} (ts is not an ISO instant): ${JSON.stringify(ts.slice(0, 48))}`,
      );
    }
    return null;
  }
  return {
    ts,
    type,
    scope,
    content: typeof fields.content === "string" ? fields.content : "",
    issue: typeof fields.issue === "string" ? fields.issue : undefined,
    tags: typeof fields.tags === "string" ? fields.tags.split(",") : undefined,
    kw: typeof fields.kw === "string" && fields.kw
      ? fields.kw.split(",").map((k) => k.trim()).filter((k) => k.length > 0)
      : undefined,
    superseded_by: typeof fields.superseded_by === "string" ? fields.superseded_by : undefined,
    reason: typeof fields.reason === "string" ? fields.reason : undefined,
    status:
      fields.status === "open" || fields.status === "settled" ? fields.status : undefined,
    repo: typeof fields.repo === "string" ? fields.repo : undefined,
    repoPath: typeof fields.repoPath === "string" ? fields.repoPath : undefined,
    file,
    index,
  };
}

export async function memoryFiles(): Promise<string[]> {
  const root = memoryRoot();
  // Bun.Glob.scan throws ENOENT on a missing root; a fresh store must read as
  // empty so the system-digest hook never throws (it runs on every request,
  // including the compaction model call).
  if (!existsSync(root)) return [];
  const glob = new Bun.Glob("*.logfmt");
  const files: string[] = [];
  for await (const f of glob.scan(root)) {
    if (!RESERVED.has(f)) files.push(join(root, f));
  }
  return files.sort();
}

export async function loadAll(): Promise<Memory[]> {
  malformedRows = 0; // per-load telemetry: the most recent read wins
  const blocked = await blockedTs();
  const out: Memory[] = [];
  for (const file of await memoryFiles()) {
    const lines = await readLines(file);
    lines.forEach((line, index) => {
      const m = toMemory(parseLine(line) ?? {}, file, index);
      if (m && !blocked.has(m.ts)) out.push(m);
    });
  }
  return out;
}

export async function loadScope(scope: string, reader: Reader = readerForAmbient()): Promise<Memory[]> {
  // Gate dedup/stale reads are repo-scoped: a row from another repo must not
  // collapse or supersede a write here. The reader is the CALLER's identity,
  // resolved at flow entry — not whatever current says after this await.
  return (await loadAll()).filter((m) => m.scope === scope && isVisibleTo(m, reader));
}
