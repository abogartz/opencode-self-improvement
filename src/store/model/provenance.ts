// Provenance: how a row was obtained (#393).
//
// R4 (`benchmark-tests/ocsi/results-poison-x5/`, n=5) is why this exists. With an
// empty store the agent produced no artifact in 3 of 5 runs and never invented a
// rate — the honest failure. With ONE plausible wrong row it shipped a WRONG
// artifact in 4 of 5 (2475, 2100, 3100, 1750) and flagged no uncertainty in any
// run. A false row is not neutral: it converts "I cannot proceed" into "I shipped
// something wrong". The rows used were real capture output with the values and
// targets swapped, so this is the same shape, same confidence, same specificity —
// not a strawman.
//
// The fix cannot be "check it against the tree", and the measurement says so:
// `findConstant(base4, "fallbackVatBps")` returns null — the fixture leaves the
// value UNSET, which is precisely why the poison had somewhere to go. A check that
// refuses a claim when the tree contradicts it refuses nothing here, and a check
// that refuses when the tree is silent also refuses the transport fact (empty
// store 0/5, seeded 5/5), which is the one measured benefit memory has.
//
// So provenance is a LABEL the reader discounts by, not a filter that decides.
// It is derived, and the derivation is total. A rule of the form "a row with no
// provenance is not injected" is only safe if nothing falls through it, and the
// real store says why: of 1014 rows, 109 carry `auto-capture`, 18 carry
// `user-guided`, none carry `import`, and **905 carry none of those** — they came
// through the tool path, which is a provenance and not an absence of one.
// Excluding untagged rows would have dropped 89% of the store from injection,
// which is a recall loss wearing a safety badge.

export type Provenance =
  /** The user said it; the row may carry the verbatim quote. */
  | "user-stated"
  /** Mined from a transcript by auto-capture. Untrusted until checked. */
  | "capture-inferred"
  /** Arrived through `memory_import` from a file another machine produced. */
  | "imported"
  /** Written by the agent or the user through a tool, in this repo. */
  | "elicited";

export interface ProvenanceInfo {
  kind: Provenance;
  /**
   * True when the row has been checked against something outside the text that
   * produced it — today, a numeric claim that agreed with the working tree.
   * This is the bit the injected line turns into `[code-checked]` versus
   * `[unverified]`.
   */
  checked: boolean;
}

/**
 * Total by construction: every row gets a class, so injection never loses a row
 * to a missing label. Order matters — a guided row that capture also mined is
 * USER-stated, because the user's authority is the stronger claim of the two.
 */
export function provenanceOf(
  tags: readonly string[] | undefined,
): ProvenanceInfo {
  const t = tags ?? [];
  if (t.includes("user-guided")) return { kind: "user-stated", checked: false };
  if (t.includes("import")) return { kind: "imported", checked: false };
  if (t.includes("auto-capture"))
    return { kind: "capture-inferred", checked: t.includes("code-checked") };
  return { kind: "elicited", checked: false };
}

/**
 * The marker that rides the injected line. Kept SHORT and kept SEPARATE from the
 * existing `[via …]` marker, whose exact text several tests pin: those tests are
 * the reason this is an appended token and not a rewrite.
 *
 * `elicited` and `user-stated` render nothing. Both are the user's own authority
 * in this repository, and decorating 905 of 1014 rows with a warning would teach
 * the model to ignore the warning.
 */
export function provenanceMarker(info: ProvenanceInfo): string {
  if (info.checked) return " [code-checked]";
  if (info.kind === "capture-inferred") return " [unverified]";
  if (info.kind === "imported") return "";
  return "";
}
