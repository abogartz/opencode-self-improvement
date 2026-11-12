// predicates — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { INIT_STAMP_TAG } from "../../core/tags.ts";
import { isQuarantined } from "../quarantine/quarantine.ts";
import type { Memory } from "./memory.ts";

export function isActive(m: Memory): boolean {
  return !m.superseded_by;
}

// Quarantine remains durable and reviewable; only model-facing reads withhold it.
// The legacy `init-stamp` tag joins it (#376 review). A pre-#374 stamp row is
// plugin bookkeeping, and migration only retires a row whose `init_complete`
// audit line survives; in a store where that line is gone the row stays active
// forever, so the tag itself has to keep it off the prompt. This is the one
// predicate every model-facing read uses, so injection, recall, list, digest and
// the capture context all withhold it together. Store reads that are NOT
// model-facing — the viewer, memory_forget, memory_undo, export — still see it.
export function isInjectable(m: Memory): boolean {
  return (
    isActive(m) &&
    !isQuarantined(m) &&
    m.tags?.includes(INIT_STAMP_TAG) !== true
  );
}
