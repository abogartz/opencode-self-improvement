// Evidence log writer. One logfmt line per event, appended in hook order to
// ~/.config/opencode/memory/evidence/<date>.logfmt. Evidence is DATA, never
// chat (invariant I3) and never inside a repo (I2).
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dateStr, evidenceDir } from "./config.ts";
import { appendLog, formatLine } from "./logfmt.ts";
import { getCurrent } from "./state.ts";

export type EvidenceEvent = string;

export async function record(
  ev: EvidenceEvent,
  fields: Record<string, unknown> = {},
  includeContext = true,
): Promise<void> {
  const { sid, call } = getCurrent();
  const line = formatLine({
    ev,
    ts: new Date().toISOString(),
    ...(includeContext ? { sid, call } : {}),
    ...fields,
  });
  await appendLog(join(evidenceDir(), `${dateStr()}.logfmt`), line);
}

export function contentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

export function chainId(): string {
  return createHash("sha1")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
}

export async function recordWriteBlocked(
  gate: number,
  reason: string,
  flags: string[],
  chain?: string,
): Promise<void> {
  await record("write_blocked", {
    gate,
    reason,
    flags: `[${flags.join(",")}]`,
    ...(chain ? { chain } : {}),
  });
}
