// release — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { join } from "node:path";
import { formatLine } from "../../core/logfmt/format.ts";
import { QUARANTINE_TAG, quarantineReasons } from "./quarantine.ts";
import { memoryFiles } from "../files/load.ts";
import { stampRow } from "../files/snapshots.ts";

// Human viewer action only. Preserve identity, origin, and all non-quarantine
// metadata; stampRow snapshots and atomically publishes under the store lock.
export async function releaseQuarantine(ts: string): Promise<"released" | "not_found" | "not_quarantined"> {
  for (const file of await memoryFiles()) {
    const result = await stampRow(file, ts, (fields) => {
      const tags = typeof fields.tags === "string" ? fields.tags.split(",") : [];
      if (!tags.includes(QUARANTINE_TAG)) return null;
      const scanTags = new Set([QUARANTINE_TAG, ...quarantineReasons({ tags }).map((id) => `quarantine:${id}`)]);
      const kept = tags.filter((tag) => !scanTags.has(tag));
      if (kept.length) fields.tags = kept.join(",");
      else delete fields.tags;
      return formatLine(fields);
    });
    if (result !== null) return result ? "released" : "not_quarantined";
  }
  return "not_found";
}
