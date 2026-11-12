/** Auto-capture provenance, shared by capture and retrieval. */
export const AUTO_CAPTURE_TAG = "auto-capture";

/**
 * #393: a capture candidate whose numeric claim was CHECKED against the working
 * tree and agreed. Absent on every other row, which is what makes the injected
 * `[unverified]` marker mean something rather than decorate everything.
 */
export const CODE_CHECKED_TAG = "code-checked";

// The pre-#374 init stamp: a `context` row written by an older release's
// `/repo-init`. It is plugin bookkeeping that the stamp file replaced, so it is
// never a fact for a model to read. `src/init/stamp.ts` retires a row once its
// audit line confirms the migration; the tag keeps every other row — including
// one whose audit line is gone, which migration cannot reach — out of the
// prompt (#376 review).
export const INIT_STAMP_TAG = "init-stamp";

// The public write boundaries reserve this same tag (#342/#355).
export { USER_GUIDED_TAG } from "./guidance.ts";
