/** Auto-capture provenance, shared by capture and retrieval. */
export const AUTO_CAPTURE_TAG = "auto-capture";

/**
 * #402: the working tree already states this fact, so the next session can read
 * it there. Captured from #389's availability check, which used to DROP these
 * candidates. Measured on this repo's store, that check refused 0 of 1166 real
 * rows after four review rounds, and the version before it refused 30 of which
 * 29 were wrong — so the verdict is a tag now, and a wrong match costs a tag
 * instead of a fact.
 *
 * Retrieval sorts these rows last within their score band: a restatement is the
 * first thing to give up budget when the block is full, and the last thing worth
 * a slot when it is not.
 */
export const RESTATABLE_TAG = "restatable";

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
