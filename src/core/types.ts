// Shared memory-row enums. Lives outside index.ts so the pure capture core
// (src/capture.ts) can reference the admissible values without importing the
// plugin entry. schema.ts uses these in tool schemas; capture.ts uses TYPES
// to prompt and validate.
export const TYPES = ["decision", "learning", "preference", "blocker", "context", "pattern"] as const;
export const STATUSES = ["open", "settled"] as const;
