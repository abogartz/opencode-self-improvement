// write — split from src/status.ts (#168 domain restructure). Declaration bodies are unchanged.
// The status hand-off between the two surface halves. The server plugin writes
// one status file per session on every epoch recompute AND every measured
// assistant turn (src/index.ts); the terminal plugin (src/tui.tsx) and the
// memory_status tool consume them. Status files are deliberately NOT .logfmt
// memory files — loadAll() must never ingest them.
//
// Why per-session: the epoch freeze is per-session, so a single global
// last-writer-wins file let one session's badge show another session's epoch.
// `status/<sessionID>.json` is the primary read; the global `status.json`
// survives as a "latest" fallback for argument-free reads. Both are pruned /
// written best-effort: a status failure degrades surfaces, never injection.
//
// Scope of v2: same-machine reads. Against a REMOTE server the terminal panel
// sees no status files (it says so) — the RPC surface is the planned follow-up.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { evidenceDir, memoryRoot } from "../core/config/paths.ts"
import { dateStr } from "../core/time.ts";
import { parseLine } from "../core/logfmt/format.ts"
import { readLines } from "../core/logfmt/read.ts";
import { type BlockedRow, SESSION_FILE_CAP, type StatusPayload, readJson, writeJson } from "./payload.ts";

export function statusFile(): string {
  return join(memoryRoot(), "status.json");
}

export function statusDir(): string {
  return join(memoryRoot(), "status");
}

// Session ids are host-generated (ses_…), but sanitize anyway: this string
// becomes a file name.
function safeName(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

export function sessionStatusFile(sessionID: string): string {
  return join(statusDir(), `${safeName(sessionID)}.json`);
}

async function pruneStatusDir(): Promise<void> {
  try {
    const names = (await readdir(statusDir())).filter((n) => n.endsWith(".json"));
    if (names.length <= SESSION_FILE_CAP) return;
    const withMtime = await Promise.all(
      names.map(async (n) => {
        try {
          return { n, m: (await stat(join(statusDir(), n))).mtimeMs };
        } catch {
          return { n, m: 0 }; // vanished mid-prune or unstatable: prune first
        }
      }),
    );
    withMtime.sort((a, b) => b.m - a.m);
    for (const f of withMtime.slice(SESSION_FILE_CAP)) {
      await rm(join(statusDir(), f.n), { force: true });
    }
  } catch {
    // pruning is housekeeping; the surfaces tolerate a growing dir
  }
}

// Best-effort by design: a status write must never break injection. Writes the
// per-session file (primary) AND the global latest file (fallback).
export async function writeStatus(p: StatusPayload): Promise<void> {
  try {
    await writeJson(statusFile(), p);
    if (typeof p.sessionID === "string" && p.sessionID) {
      await writeJson(sessionStatusFile(p.sessionID), p);
      await pruneStatusDir();
    }
  } catch {
    // Resolving an existing root can also fail its permission check.
  }
}

/**
 * Read the status for a session. With a sessionID: ONLY that session's file —
 * a missing file returns null ("mem -") rather than another session's epoch.
 * Without one: the global latest file.
 */
export async function readStatus(sessionID?: string): Promise<StatusPayload | null> {
  try {
    if (sessionID) return await readJson(sessionStatusFile(sessionID));
    return await readJson(statusFile());
  } catch {
    return null; // an inaccessible root is also "no data"
  }
}

// Newest-first last `limit` write_blocked evidence rows, scanning today and
// yesterday so a block just before midnight stays visible.
export async function blockedRecent(limit = 6): Promise<BlockedRow[]> {
  const today = dateStr();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0]!;
  const rows: BlockedRow[] = [];
  for (const day of [yesterday, today]) {
    for (const line of await readLines(join(evidenceDir(), `${day}.logfmt`))) {
      const f = parseLine(line);
      if (!f || f.ev !== "write_blocked") continue;
      rows.push({
        ts: String(f.ts ?? day),
        sid: String(f.sid ?? "?"),
        reason: String(f.reason ?? "?"),
      });
    }
  }
  return rows.slice(-limit).reverse();
}
