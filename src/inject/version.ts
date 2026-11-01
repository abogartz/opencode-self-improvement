// version — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
// Context surfaces: a small system digest, a capped open-thread frontier, and
// relevance-ranked memory frozen per epoch by src/index.ts. These ride the
// session context hook's system parts. Contextual pull appends relevant memory
// to grep/glob/read results. Evidence is never injected.
import { createHash } from "node:crypto";
import { loadAll } from "../store/files/load.ts"
import { type Memory } from "../store/model/memory.ts"
import { isInjectable } from "../store/model/predicates.ts"
import { readerFromSid, visibleTo } from "../store/model/visibility.ts";
import { cmpTs } from "../core/cmp-ts.ts";
import { formatMemory } from "./format.ts";

// Deterministic fingerprint of the rows that can affect injection. Hash the
// exact rendered row plus its full id, in load order: content edits, blocklist
// changes and supersession all invalidate an epoch, while evidence, hidden
// rows and non-rendered metadata do not. This is only a linear hash over rows
// loadAll() already had to read and parse for the request.
export async function storeVersion(rows?: Memory[], sid?: string): Promise<string> {
  // Repo-scoped: model-facing reads see the caller's repo + global rows.
  const mems = (rows ?? visibleTo(await loadAll(), readerFromSid(sid))).filter(isInjectable);
  if (!mems.length) return "0:";
  let max = "";
  const hash = createHash("sha256");
  for (const m of mems) {
    if (cmpTs(m.ts, max) > 0) max = m.ts;
    hash.update(JSON.stringify([m.ts, formatMemory(m)]));
    hash.update("\n");
  }
  return `${mems.length}:${max}:${hash.digest("hex")}`;
}
