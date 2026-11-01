// publish — split from src/logfmt.ts (#168 domain restructure). Declaration bodies are unchanged.
// Minimal logfmt reader/writer shared by the durable store and the evidence
// log. Field order is preserved on write so chains are diffable.
import { dirname } from "node:path";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { IS_WINDOWS } from "./format.ts";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function appendLog(file: string, line: string): Promise<void> {
  await ensureDir(dirname(file));
  const next = line.endsWith("\n") ? line : line + "\n";
  // One O_APPEND write: read-modify-write loses rows under concurrent
  // appenders (20 concurrent appends left 2 on disk). appendFile's "a" flag is
  // O_APPEND|O_CREAT — atomic small writes on local POSIX filesystems,
  // covering interleaved async tasks in the service AND a second process
  // (the viewer) appending the same day file. Do NOT "simplify" back to
  // Bun.write with an options object: on Bun 1.4.3 that silently TRUNCATES.
  // Appending is safe against other appenders only. Callers writing a file that
  // is ALSO rewritten whole (a daily memory file, the blocklist) hold the store
  // lock around this — see lock.ts.
  await appendFile(file, next);
}

// A change-detection token for one file: any append, rewrite or replacement
// changes it. "absent" marks a file that does not exist yet. Readers of the
// freshness contract below take it BEFORE reading, so it pins the state the
// published content was derived from.
export async function fileIdentity(file: string): Promise<string> {
  try {
    const s = await stat(file, { bigint: true });
    return `${s.ino}|${s.size}|${s.mtimeNs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return "absent";
  }
}

// Publish whole-file content so no reader can observe a partial store. Recall,
// injection and the viewer read these files without taking the lock, so the
// handover is a same-directory rename (atomic on POSIX): a reader sees either
// the previous file or the new one, never a truncated middle. Callers hold the
// store lock for the whole read-modify-write.
//
// `since` is the fileIdentity() taken before the caller read the file it is
// deriving `content` from. With it, a Windows handover that fails on reader
// contention can retry without risking a stale publish (see handoverRename).
// Without it, publishing behaves exactly as it always has: one rename.
let tmpSeq = 0;

export async function writeAtomic(file: string, content: string, since?: string): Promise<void> {
  await ensureDir(dirname(file));
  // Unique PER CALL, not per process: shared store writers now fail closed on
  // lock timeout, but direct/legacy callers can still overlap. A pid-stable
  // name would let one call replace the bytes another call's anchored publish
  // is retrying. Keep separate temps even when the caller holds a lock.
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    await Bun.write(tmp, content);
    await handoverRename(tmp, file, since);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// POSIX renames swap a file out from under an open reader; the handover needs
// one call, and a failure there is fatal, never contention. Windows mandatory
// locking instead REFUSES to replace a destination any reader still holds,
// while that handle lives. Readers of a small store file cycle their handle on
// a microsecond scale, so that failure is usually transient and worth a retry
// window (~2s, well inside the 5s lock budget) — but a retry alone is not safe
// here. If an out-of-band or legacy unlocked writer appends into the
// destination DURING the window, the
// retried rename publishes our now-stale copy over that row — a slower way to
// lose exactly what the immediate failure preserved. So the retry runs only
// while the destination still matches `since`, the identity from before the
// caller's read: match means no one moved the file and the blocker is a bare
// reader handle, a mismatch means the write's premise is gone and it fails
// with the original error, as the no-retry path always did. Hence also: no
// `since`, no retry.
async function handoverRename(tmp: string, file: string, since?: string): Promise<void> {
  try {
    await rename(tmp, file);
    return;
  } catch (err) {
    if (!IS_WINDOWS || since === undefined) throw err;
    const deadline = Date.now() + 2000;
    let backoff = 1;
    for (;;) {
      const now = Date.now();
      if (now >= deadline) throw err;
      await new Promise((r) => setTimeout(r, Math.min(backoff, deadline - now)));
      backoff = Math.min(backoff * 2, 50);
      if ((await fileIdentity(file)) !== since) throw err; // destination moved; our copy is stale
      try {
        await rename(tmp, file);
        return;
      } catch {
        // Still the reader's turn to block us (or a fresh one); the identity
        // check at the top of the next pass is what distinguishes the two.
      }
    }
  }
}
