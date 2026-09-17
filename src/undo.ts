// Snapshot/rollback (/undo analog). Snapshots are written by memory.ts before
// any mutation; restore copies one back over its original file.
import { join, basename } from "node:path";
import { snapshotDir } from "./config.ts";
import { ensureDir } from "./logfmt.ts";

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

// Restore `snapshot` over its original file. The snapshot name is
// `<stamp>-<original>.logfmt`; strip the stamp to recover the target.
export async function restoreSnapshot(snapshot: string, memoryRootDir: string): Promise<string> {
  const f = Bun.file(snapshot);
  if (!(await f.exists())) throw new Error(`snapshot not found: ${snapshot}`);
  const name = basename(snapshot);
  const original = name.replace(/^\d+-/, "");
  const target = join(memoryRootDir, original);
  await ensureDir(memoryRootDir);
  await Bun.write(target, await f.text());
  return target;
}
