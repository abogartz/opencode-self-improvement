/** Auto-capture provenance, shared by capture and retrieval. */
export const AUTO_CAPTURE_TAG = "auto-capture";

/**
 * #393: a capture candidate whose numeric claim was CHECKED against the working
 * tree and agreed. Absent on every other row, which is what makes the injected
 * `[unverified]` marker mean something rather than decorate everything.
 */
export const CODE_CHECKED_TAG = "code-checked";

// The public write boundaries reserve this same tag (#342/#355).
export { USER_GUIDED_TAG } from "./guidance.ts";
