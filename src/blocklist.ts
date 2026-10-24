// Human intervention for poisoned/stale memory. A blocked memory is
// still retained on disk (never destroyed) but is filtered out of every read
// path: recall, the injected digest and contextual pull, and the viewer's
// active list. Blocklist lives at <memoryRoot>/blocklist.logfmt so a recursive
// memory scan must never pick it up.
import { join } from "node:path";
import { memoryRoot } from "./config.ts";
import { appendLog, fileIdentity, formatLine, parseLine, readLines, writeAtomic } from "./logfmt.ts";
import { withStoreLock, LOCK_WRITE } from "./lock.ts";

const BLOCKLIST_FILENAME = "blocklist.logfmt";

export interface BlockEntry {
  ts: string;
  reason: string;
  blocked_at: string;
}

export function blocklistFile(): string {
  return join(memoryRoot(), BLOCKLIST_FILENAME);
}

export async function blockedEntries(): Promise<BlockEntry[]> {
  const lines = await readLines(blocklistFile());
  const out: BlockEntry[] = [];
  for (const line of lines) {
    const f = parseLine(line);
    if (!f || typeof f.ts !== "string") continue;
    out.push({
      ts: f.ts,
      reason: typeof f.reason === "string" ? f.reason : "",
      blocked_at: typeof f.blocked_at === "string" ? f.blocked_at : "",
    });
  }
  return out;
}

export async function blockedTs(): Promise<Set<string>> {
  return new Set((await blockedEntries()).map((b) => b.ts));
}

export async function addBlock(ts: string, reason: string): Promise<string> {
  if (!reason.trim()) throw new Error("reason is required to block a memory");
  const file = blocklistFile();
  await withStoreLock(
    file,
    () => appendLog(file, formatLine({ ts, reason, blocked_at: new Date().toISOString() })),
    LOCK_WRITE,
  );
  return ts;
}

// Unblocking filters the file down, so it republishes it whole: both paths hold
// the blocklist lock or the slower one loses the other's entries.
export async function removeBlock(ts: string): Promise<boolean> {
  const file = blocklistFile();
  return withStoreLock(
    file,
    async () => {
      const store = Bun.file(file);
      if (!(await store.exists())) return false;
      const since = await fileIdentity(file);
      const kept = (await store.text()).split("\n").filter((l) => {
        const row = parseLine(l);
        return !(row && row.ts === ts);
      });
      await writeAtomic(file, kept.join("\n") + (kept.length ? "\n" : ""), since);
      return true;
    },
    LOCK_WRITE,
  );
}
