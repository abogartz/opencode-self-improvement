// predicates — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { isQuarantined } from "../quarantine/quarantine.ts";
import { type Memory } from "./memory.ts";

export function isActive(m: Memory): boolean {
  return !m.superseded_by;
}

// Quarantine remains durable and reviewable; only model-facing reads withhold it.
export function isInjectable(m: Memory): boolean {
  return isActive(m) && !isQuarantined(m);
}
