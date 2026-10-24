// Snapshot/rollback (/undo analog). Snapshots are written by memory.ts before
// any mutation; restore copies one back over its original file.
//
// Daily logfmt files are SHARED across concurrent sessions, so a naive
// whole-file write can silently clobber rows another session appended after
// the snapshot. Restore is therefore conflict-aware: the snapshot cannot tell
// "rows I added since the snapshot, which undo should remove" apart from
// "rows another session added, which must survive", so that call belongs to
// the caller. The default mode CHECK refuses and lists the divergent rows;
// MERGE replays them on top of the snapshot; FORCE is the old exact rollback,
// and additionally snapshots the file it replaces, so the state it drops stays
// undoable (result.safety).
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deletionsFile, snapshotDir } from "./config.ts";
import { ensureDir, fileIdentity, parseLine, readLines, writeAtomic } from "./logfmt.ts";
import { withStoreLock, LOCK_RESTORE } from "./lock.ts";
import { snapshotFiles } from "./memory.ts";

const SNAPSHOT_NAME = /^(\d+)-(\d{4}-\d{2}-\d{2}\.logfmt)$/;

function matchSnapshotName(name: string): RegExpExecArray | null {
  const match = SNAPSHOT_NAME.exec(name);
  if (!match) return null;
  const original = match[2];
  if (!original) return null;
  const year = Number(original.slice(0, 4));
  const month = Number(original.slice(5, 7));
  const day = Number(original.slice(8, 10));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? match
    : null;
}

export interface SnapshotInfo {
  file: string;
  name: string;
  bytes: number;
  mtime: number;
}

export async function listSnapshots(): Promise<SnapshotInfo[]> {
  const glob = new Bun.Glob("*.logfmt");
  const out: SnapshotInfo[] = [];
  try {
    for await (const f of glob.scan(snapshotDir())) {
      if (!matchSnapshotName(f)) continue;
      const info = Bun.file(join(snapshotDir(), f));
      out.push({
        file: join(snapshotDir(), f),
        name: f,
        bytes: info.size,
        mtime: info.lastModified ?? 0,
      });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export type RestoreMode = "check" | "merge" | "force";

export interface RestoreResult {
  target: string;
  restored: boolean;
  mode: RestoreMode;
  // Snapshot of the file as it stood the moment the restore held the lock —
  // present on a force restore, which is the mode that drops rows.
  safety?: string;
  // ts of rows present in the CURRENT file but absent from the snapshot
  // (added after it — or in-place edits, listed under their original ts).
  concurrentAdded: string[];
  concurrentChanged: string[];
  // ts of rows intentionally deleted after this snapshot. CHECK and MERGE
  // leave them deleted; FORCE is the explicit recovery path.
  deletedOmitted: string[];
}

// Rows are keyed by their ts= field; unparseable lines key on the whole line.
function rowKey(line: string): string {
  return line.match(/^ts=(\S+)/)?.[1] ?? line;
}

function rows(text: string): string[] {
  return text.split("\n").filter((l) => l.trim());
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function resolveSnapshot(
  snapshot: string,
  memoryRootDir: string,
): Promise<{ path: string; original: string }> {
  const name = basename(snapshot);
  const match = matchSnapshotName(name);
  const original = match?.[2];
  const stamp = match ? Number(match[1]) : Number.NaN;
  if (!original || !Number.isSafeInteger(stamp)) {
    throw new Error(`invalid snapshot name: ${name}`);
  }
  if (!isAbsolute(snapshot) && snapshot !== name) {
    throw new Error("snapshot must be a bare name from memory_undo list or a full path");
  }

  const rootResolved = resolve(memoryRootDir);
  const snapshotsResolved = resolve(rootResolved, "snapshots");
  const requestedResolved = isAbsolute(snapshot)
    ? resolve(snapshot)
    : resolve(snapshotsResolved, name);
  if (!isWithin(snapshotsResolved, requestedResolved)) {
    throw new Error(`snapshot is outside the snapshots directory: ${snapshot}`);
  }

  let rootReal: string;
  let snapshotsReal: string;
  let snapshotReal: string;
  try {
    [rootReal, snapshotsReal, snapshotReal] = await Promise.all([
      realpath(rootResolved),
      realpath(snapshotsResolved),
      realpath(requestedResolved),
    ]);
  } catch {
    throw new Error(`snapshot not found: ${snapshot}`);
  }
  if (!isWithin(rootReal, snapshotsReal)) {
    throw new Error("snapshots directory escapes the memory root");
  }
  if (!isWithin(snapshotsReal, snapshotReal)) {
    throw new Error(`snapshot is outside the snapshots directory: ${snapshot}`);
  }

  const [linkInfo, fileInfo] = await Promise.all([
    lstat(requestedResolved),
    stat(snapshotReal),
  ]);
  if (linkInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error(`snapshot is not a regular file: ${snapshot}`);
  }

  return { path: snapshotReal, original };
}

// ts of every row memory_forget or a viewer delete has removed. Ordering
// against the snapshot is not needed: a snapshot row with a deletion audit
// that is absent from the live file was removed on purpose.
async function auditedDeletions(): Promise<Set<string>> {
  const deleted = new Set<string>();
  for (const line of await readLines(deletionsFile())) {
    const fields = parseLine(line);
    if (fields?.action !== "deleted" || typeof fields.original_ts !== "string") continue;
    deleted.add(fields.original_ts);
  }
  return deleted;
}

// Restore `snapshot` over its original file. Only `<stamp>-<YYYY-MM-DD>.logfmt`
// files inside <memory-root>/snapshots/ are accepted (the viewer restore's
// grammar); the stamp is stripped to recover the target day file. A bare name
// (as printed by the list) resolves against <memory-root>/snapshots/.
export async function restoreSnapshot(
  snapshot: string,
  memoryRootDir: string,
  mode: RestoreMode = "check",
): Promise<RestoreResult> {
  const snap = await resolveSnapshot(snapshot, memoryRootDir);
  const rootReal = await realpath(resolve(memoryRootDir));
  const realTarget = resolve(rootReal, snap.original);
  if (!isWithin(rootReal, realTarget)) {
    throw new Error(`snapshot target escapes the memory root: ${snap.original}`);
  }
  let targetInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    targetInfo = await lstat(realTarget);
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
  }
  if (targetInfo) {
    if (targetInfo.isSymbolicLink()) {
      throw new Error(`snapshot target must not be a symbolic link: ${snap.original}`);
    }
    const targetReal = await realpath(realTarget);
    if (relative(realTarget, targetReal) !== "") {
      throw new Error(`snapshot target must not be a symbolic link: ${snap.original}`);
    }
    if (!targetInfo.isFile()) throw new Error(`snapshot target is not a file: ${snap.original}`);
  }
  // Checks above ran on real paths; lock and write through the same lexical
  // path every other writer uses, so the in-process lock queue is shared.
  const target = resolve(memoryRootDir, snap.original);
  const rawSnapLines = rows(await Bun.file(snap.path).text());

  // Comparing and publishing happen under the same lock: a divergence check on
  // a stale read would wave through a row that landed after it. A restore waits
  // for the store rather than proceeding unlocked, because "force" deliberately
  // drops rows — doing that on top of a racing writer would drop rows nobody
  // agreed to drop.
  return withStoreLock(
    target,
    async () => {
      // Identity before the first read of `target` here: everything published
      // below derives from what this read sees (logfmt.ts handoverRename).
      const since = await fileIdentity(target);
      const cur = Bun.file(target);
      const curLines = (await cur.exists()) ? rows(await cur.text()) : [];
      // Deliberate deletions are read inside the lock too, so a forget that
      // finished just before this restore is honoured.
      const audited = mode !== "force" ? await auditedDeletions() : new Set<string>();
      const live = new Set(curLines.map(rowKey));
      const deletedOmitted: string[] = [];
      const snapLines = rawSnapLines.filter((line) => {
        const key = rowKey(line);
        if (!audited.has(key) || live.has(key)) return true;
        deletedOmitted.push(key);
        return false;
      });

      const snapByKey = new Map(snapLines.map((l) => [rowKey(l), l]));
      const concurrentAdded: string[] = [];
      const concurrentChanged: string[] = [];
      const curByKey = new Map<string, string>();
      for (const l of curLines) {
        const k = rowKey(l);
        curByKey.set(k, l);
        const s = snapByKey.get(k);
        if (s === undefined) concurrentAdded.push(k);
        else if (s !== l) concurrentChanged.push(k);
      }

      if (mode === "check" && (concurrentAdded.length || concurrentChanged.length)) {
        return { target, restored: false, mode, concurrentAdded, concurrentChanged, deletedOmitted };
      }

      // FORCE is the mode that drops rows, so the file it replaces is
      // snapshotted HERE — inside the lock, which is what makes rows a
      // concurrent session appended moments earlier part of the copy. A caller
      // that snapshots before this call races the very write it means to save.
      const safety = mode === "force" ? (await snapshotFiles([target]))[0] : undefined;

      let out = snapLines;
      if (mode === "merge") {
        // Keep the CURRENT version of rows the snapshot also has (in-place edits —
        // e.g. a supersede stamp — made after the snapshot win), then append the
        // rows the snapshot never saw. Merge is a deliberate superset: rows the
        // snapshotter wrote after the snapshot are NOT dropped here; choose FORCE
        // for that.
        out = snapLines.map((l) => curByKey.get(rowKey(l)) ?? l).concat(
          curLines.filter((l) => !snapByKey.has(rowKey(l))),
        );
      }
      await ensureDir(memoryRootDir);
      await writeAtomic(target, out.length ? out.join("\n") + "\n" : "", since);
      return { target, restored: true, mode, safety, concurrentAdded, concurrentChanged, deletedOmitted };
    },
    LOCK_RESTORE,
  );
}
