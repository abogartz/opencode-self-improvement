// Human intervention for poisoned/stale memory (SPEC). A blocked memory is
// still retained on disk (never destroyed) but is filtered out of every read
// path: recall, the injected digest and contextual pull, and the viewer's
// active list. Blocklist lives at <memoryRoot>/blocklist.logfmt so a recursive
// memory scan must never pick it up.
import { join } from "node:path";
import { memoryRoot } from "./config.ts";
import { appendLog, formatLine, parseLine, readLines } from "./logfmt.ts";

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
  await appendLog(blocklistFile(), formatLine({ ts, reason, blocked_at: new Date().toISOString() }));
  return ts;
}

export async function removeBlock(ts: string): Promise<boolean> {
  const file = Bun.file(blocklistFile());
  if (!(await file.exists())) return false;
  const kept = (await file.text()).split("\n").filter((l) => {
    const f = parseLine(l);
    return !(f && f.ts === ts);
  });
  await Bun.write(blocklistFile(), kept.join("\n") + (kept.length ? "\n" : ""));
  return true;
}