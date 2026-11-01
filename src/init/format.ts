// format — split from src/init.ts (#168 domain restructure). Declaration bodies are unchanged.
// Repository init: ensure the codebase-memory graph exists for this repo and
// re-derive build/test command memories through the write gate. Deterministic
// (no model calls): the graph binary is spawned one-shot via `cli`, manifests
// are parsed locally, and every write goes through the 4-gate pipeline with the
// `trusted` flag (plugin-authored bookkeeping, not model claims). Degrades
// gracefully when the binary or git is absent, so install-from-scratch still
// writes script memories.
import { join } from "node:path";
import { type InitSummary } from "./run.ts";

export function formatInit(s: InitSummary): string {
  if (s.skipped) {
    return `Already initialized for ${s.scope} at head ${s.head} (stamp ${s.stampTs}). Nothing to do.`;
  }
  const scr = s.scripts.map((r) => `- ${r.source}: "${r.cmd}"`).join("\n");
  return [
    `Initialized ${s.scope} (root ${s.root}, head ${s.head}).`,
    `Graph: ${s.graph.action}${s.graph.name ? ` (${s.graph.name})` : ""} [mode=${s.graph.mode}]`,
    scr ? `Scripts (${s.scripts.length}):\n${scr}` : "Scripts: none detected",
    `Memories: written=${s.written}, collapsed=${s.collapsed}, blocked=${s.blocked}` +
      (s.unaudited ? `, ${s.unaudited} without an audit line` : "") +
      `; stamp=${s.stampTs ?? "-"}`,
  ].join("\n");
}
