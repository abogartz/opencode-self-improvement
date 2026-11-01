// snapshots — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { open, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { snapshotDir } from "../../core/config/paths.ts";
import { parseLine, type Fields } from "../../core/logfmt/format.ts"
import { ensureDir, fileIdentity, writeAtomic } from "../../core/logfmt/publish.ts"
import { readLines } from "../../core/logfmt/read.ts";
import { withStoreLock, LOCK_WRITE } from "../lock.ts";

// Copy `file` into snapshots/ before a mutation.
export async function snapshotBefore(file: string): Promise<void> {
  await snapshotFiles([file]);
}

// Read-modify-write ONE row of a store file: read, rewrite the line, publish
// atomically, all under the store lock, so an append or another rewrite by a
// concurrent session cannot be overwritten by our stale copy. Resolves to null
// when the row is not in this file, otherwise the mutation's outcome.
export async function stampRow(
  file: string,
  ts: string,
  mutate: (fields: Fields) => string | null,
): Promise<boolean | null> {
  return withStoreLock(
    file,
    async () => {
      // Identity BEFORE the read: it pins the state `lines` was derived from,
      // so writeAtomic can refuse to publish if anything moved the file
      // meanwhile (Windows retry path — see logfmt.ts handoverRename).
      const since = await fileIdentity(file);
      const lines = await readLines(file);
      const idx = lines.findIndex((l) => {
        const f = parseLine(l);
        return f && f.ts === ts;
      });
      if (idx === -1) return null;
      const parsed = parseLine(lines[idx]);
      if (!parsed) return false;
      const next = mutate(parsed);
      if (next === null) return false;
      lines[idx] = next;
      await snapshotBefore(file);
      await writeAtomic(file, lines.join("\n") + "\n", since);
      return true;
    },
    LOCK_WRITE,
  );
}

// Claim a snapshot name with O_EXCL so "never overwrite a snapshot" holds
// across processes, not just inside one: two sessions mutating the same file in
// one millisecond both bump instead of one clobbering the other's still-undoable
// copy. Names are `<epoch-ms>-<original>` because /undo strips the leading stamp
// to find its target, so nothing may go in front of it.
async function claimSnapshot(file: string): Promise<string> {
  await ensureDir(snapshotDir());
  let stamp = Date.now();
  for (;;) {
    const snap = join(snapshotDir(), `${stamp}-${basename(file)}`);
    try {
      const handle = await open(snap, "wx");
      await handle.close();
      return snap;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      stamp++;
    }
  }
}

// Snapshot-before-mutate: copy each affected file into snapshots/ so /undo can
// restore it. Returns the snapshot paths keyed by original file.
export async function snapshotFiles(files: string[]): Promise<string[]> {
  const snaps: string[] = [];
  for (const file of files) {
    let contents: Buffer;
    try {
      contents = await readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const snap = await claimSnapshot(file);
    await Bun.write(snap, contents);
    snaps.push(snap);
  }
  return snaps;
}
