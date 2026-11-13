import { RESTATABLE_TAG } from "./tags.ts";

/** Capture-only provenance: grants always-ride priority in the hint channel. */
export const USER_GUIDED_TAG = "user-guided";

/**
 * Tool/import input cannot grant capture provenance. Split the storage
 * delimiter first: ["ordinary,user-guided"] reads back as two tags too.
 * Silently drop the reserved tag; ordinary prose still faces the write gate.
 *
 * `restatable` is dropped for the same reason it cannot be granted: it is a
 * verdict about a SPECIFIC prose against a SPECIFIC working tree, and neither
 * survives these paths.
 *
 *   - `tools/update.ts` carries the target's tags onto the replacement row. A
 *     user correcting a restatable row would otherwise leave the corrected prose
 *     demoted in injection forever, on a verdict that described the superseded
 *     text — the one case where the demotion is guaranteed wrong rather than
 *     merely possible.
 *   - `portable/import.ts` moves a row between machines. The tag asserts "THIS
 *     tree states it"; an imported row keeps another machine's verdict and is
 *     demoted against a tree that was never scanned.
 *
 * A row that is genuinely restatable gets the tag again from the next capture
 * pass, so dropping it costs a demotion and never a fact.
 *
 * The viewer's edit path deliberately does NOT go through here: #129 keeps tag
 * provenance across a typo fix, where the verdict still describes the prose, and
 * a human can clear the tag by hand.
 */
export function nonCaptureTags(tags?: string[]): string[] | undefined {
  return tags
    ?.flatMap((tag) => tag.split(","))
    .filter((tag) => tag !== USER_GUIDED_TAG && tag !== RESTATABLE_TAG);
}
