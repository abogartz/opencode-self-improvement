// budgets — split from src/config.ts (#168 domain restructure). Declaration bodies are unchanged.


// Character budget for the injected "Relevant durable memory" block (the
// cache-safe epoch injection). Overridable via OPENCODE_MEMORY_INJECT_BUDGET
// (plugin options take precedence — see src/index.ts); falls back to 1200 on
// missing or invalid values.
export function injectBudget(): number {
  const raw = process.env.OPENCODE_MEMORY_INJECT_BUDGET;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1200;
}

// Character budget for the session-start open-thread frontier. Kept separate
// from relevance injection and contextual pulls: planning rows are often much
// longer, and raising this cap must not raise those per-request surfaces too.
// Defaults to 3x the effective injection budget.
export function frontierBudget(baseBudget = injectBudget()): number {
  const raw = process.env.OPENCODE_MEMORY_FRONTIER_BUDGET;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return baseBudget * 3;
}
