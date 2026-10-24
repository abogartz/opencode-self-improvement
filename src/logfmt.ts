// Minimal logfmt reader/writer shared by the durable store and the evidence
// log. Field order is preserved on write so chains are diffable.
import { dirname } from "node:path";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";

const IS_WINDOWS = process.platform === "win32";

export type Fields = Record<string, unknown>;

// Escapes for quoted values. One record is one line, so a raw newline inside a
// value would end the record early and the rest of the value would be read
// back as a separate line of fields. Backslash is escaped too, so a value
// ending in `\` cannot swallow its closing quote.
const ESCAPE: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const UNESCAPE: Record<string, string> = { "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" };

// Lines written before these escapes existed stored backslashes raw, so in an
// old line `C:\new` is a backslash and an `n`, not a newline. A line whose
// values use the escapes ends with this marker, and only fields before it are
// unescaped; everything else is read the old way, where only `\"` is an escape.
// Fields after the marker were appended by an older version (supersede adds
// fields to the end of an existing line). Lines without backslashes, newlines
// or tabs read the same either way, so they don't carry the marker.
const MARKER = "esc";
const MARKER_VALUE = "1";

export function quote(value: unknown): string {
  const s = String(value);
  if (s === "") return '""';
  return /[\s"=]/.test(s) ? `"${s.replace(/[\\"\n\r\t]/g, (c) => ESCAPE[c])}"` : s;
}

export function formatLine(fields: Fields): string {
  const parts: string[] = [];
  let escaped = false;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || k === MARKER) continue;
    const q = quote(v);
    if (q.startsWith('"') && /[\\\n\r\t]/.test(String(v))) escaped = true;
    parts.push(`${k}=${q}`);
  }
  if (escaped) parts.push(`${MARKER}=${MARKER_VALUE}`);
  return parts.join(" ");
}

// Unescape a quoted logfmt value and read it back. Unknown sequences are kept
// as written.
function unquote(s: string): string {
  return s.replace(/\\(.)/g, (seq, c: string) => UNESCAPE[c] ?? seq);
}

function unquoteLegacy(s: string): string {
  return s.replace(/\\"/g, '"');
}

export function parseLine(line: string): Fields | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("=")) return null;
  const tokens: [string, string][] = [];
  const re = /([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|[^\s]*)/g;
  for (;;) {
    const m = re.exec(trimmed);
    if (!m) break;
    tokens.push([m[1], m[2]]);
  }
  const marker = tokens.findIndex(([k, v]) => k === MARKER && v === MARKER_VALUE);
  const fields: Fields = {};
  tokens.forEach(([key, value], i) => {
    if (key === MARKER) return;
    let raw = value;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      raw = (i < marker ? unquote : unquoteLegacy)(raw.slice(1, -1));
    }
    fields[key] = raw;
  });
  // parse booleans/numbers as strings is fine; callers coerce.
  return fields;
}

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
export async function writeAtomic(file: string, content: string, since?: string): Promise<void> {
  await ensureDir(dirname(file));
  // One writer per file (the store lock), so the temp name is stable per
  // process and a crash leaves one leftover instead of one per attempt.
  const tmp = `${file}.${process.pid}.tmp`;
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
// here. If an unlocked writer (a starved lock waiter runs its write anyway;
// see lock.ts onTimeout) appends into the destination DURING the window, the
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

export async function readLines(file: string): Promise<string[]> {
  const f = Bun.file(file);
  if (!(await f.exists())) return [];
  const text = await f.text();
  return text.split("\n").filter((l) => l.trim().length > 0);
}

export function bracketList(items: string[]): string {
  return `[${items.join(",")}]`;
}
