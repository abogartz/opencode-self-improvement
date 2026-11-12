// prompt — split from src/capture.ts (#168 domain restructure). Declaration bodies are unchanged.
// Opt-in auto-capture parsing, prompt, and lag helpers. Host access and model
// calls live in src/index.ts. Every candidate that leaves this module flows
// through runWriteGate in index.ts: capture NEVER writes memories directly,
// so dupes/stale/canonical rules keep the moat (same as model-authored writes).
// All parsing functions are TOTAL: any malformed input yields [] / "" / null,
// never a throw.
import { TYPES } from "../core/types.ts";
import { redactSecrets } from "../store/secrets.ts";

export interface CaptureCandidate {
  type: string;
  scope: string;
  content: string;
  status?: "open" | "settled";
  /** Retrieval keywords (#40): indexed by the store, never rendered. */
  kw?: string[];
  /** Literal true only when the user stated the fact, not agent inference. */
  guided?: boolean;
  /** Optional literal comparison metadata, retained only for guided rows. */
  ref?: string;
  claim?: string;
  klass?: "spec" | "behavior";
  /**
   * Verbatim user utterance behind a guided row (bench mystery 2, candidate
   * 4): the capture model's paraphrase of a hint made the bench's exact-text
   * needle miss a row that actually rode. The runtime verifies this against
   * the transcript the model saw — a quote that is not a substring is dropped,
   * so a stored original is the user's own words.
   */
  original?: string;
  /**
   * Lesson citation (S1, learn-from-failure): the failing command this
   * `blocker` row is about. Present only on a lesson, and only ever copied from
   * the ATTESTED FAILURES block the prompt was given — the runtime re-checks it
   * against the tool ledger and drops the ROW when it does not appear there.
   * Unlike a guided `original`, a failed check cannot keep the row and drop the
   * field: an uncited lesson is not a lesson with a missing annotation, it is a
   * guess about what is broken. Not stored — it is a write-time gate, so no row
   * format changes.
   */
  failure?: string;
}

// Keywords are the vocabulary bridge for the strict-paraphrase wall, mined from
// the transcript the model just saw. Cap and shape mirror the store's own
// limits; the store normalises again at write, so this only has to stay
// junk-proof (capture.ts never imports the store — it stays dependency-free).
export const CAPTURE_KEYWORD_CAP = 8;

export const CAPTURE_KEYWORD_CHARS = 48;

// Prompt for the cheap capture model. The output contract is a bare JSON
// array so parseCandidates can trust it; anything else parses to [].
//
// `userProse` keeps the session's brief OUT of the work block. Measured on the
// fixture that reproduces #329: brief mixed into one undifferentiated block,
// the model stores it back as a durable `preference`; work block alone, zero
// framing rows — but also zero real preferences, because "we use bun here, not
// npm" lives in the same prose. So the prose is kept, labelled for what it is.
export function buildCapturePrompt(
  transcript: string,
  max = 3,
  userProse = "",
  known = "",
  attested?: string[],
): string {
  const prose = redactSecrets(userProse).trim();
  const knownList = redactSecrets(known).trim();
  return [
    "You mine one coding-agent session transcript for durable memories worth keeping across future sessions.",
    "",
    `Output ONLY a JSON array of at most ${max} objects (a fenced json block is fine), each:`,
    '{"type": "...", "scope": "...", "content": "...", "status": "...", "kw": ["...", "..."], "guided": true}',
    "",
    "Rules:",
    `- type: one of ${TYPES.join(", ")}.`,
    "- scope: short area name (e.g. auth, api, build).",
    '- status: "open" for a live planning thread; otherwise "settled".',
    "- content: one self-contained fact, 20-600 characters, useful in a NEW session.",
    "- kw: 3-5 search keywords for how a DIFFERENT session would ask for this — synonyms and alternate names, other verb forms, the literal command or file name. They are indexed for retrieval and never shown to a model. Omit (or []) when the content already uses those words.",
    "- guided: true ONLY when the user STATED this fact in their own words — a value, rate, number, rule or correction that appears in a user: line or the REQUESTS block. Omit guided for anything the agent discovered by itself.",
    '- When guided AND the value names a declared code symbol, also output "ref": that symbol exactly as declared (e.g. "TAX_RATE"), "claim": the user\'s value alone (e.g. "0.0825", at most 32 characters), and "klass": "spec" when the user is the authority on the value (a rate, a requirement) or "behavior" when the row describes how working code behaves. Omit all three when no single declared constant is involved.',
    '- If it is unclear whether the user is specifying a requirement or describing working code, omit "klass". Never guess authority; an unclassified row remains plain guidance without a conflict verdict.',
    '- Worked example (only when the user actually states this requirement): user says "The constant TAX_RATE in src/pricing.ts must be 0.0825." Emit:',
    '{"type":"context","scope":"pricing","content":"The constant TAX_RATE in src/pricing.ts must be 0.0825.","kw":["TAX_RATE","sales tax"],"guided":true,"ref":"TAX_RATE","claim":"0.0825","klass":"spec"}',
    "- A guided row states the user's value or rule and NOTHING more: never claim what hidden tests, graders or suites 'encode' — you cannot see them, and the claim makes the row impossible to check.",
    // Mystery 2 (FINDINGS §3): the guided hint reached pass 2 on the wire in
    // 3 of 4 t3 runs, and the miss could not be attributed — capture may have
    // paraphrased the hint, so the bench's exact-text needle missed a row that
    // actually rode. Storing the user's verbatim words makes the needle match
    // deterministic; the runtime drops any quote that is not a transcript
    // substring, so this field can only ever carry what the user actually said.
    '- When guided, also output "original": the user\'s own words for this fact, copied VERBATIM from a user: line or the REQUESTS block — no paraphrase, no reordering, at most 300 characters. Omit original when no single user line states the fact.',
    "- Keep: decisions made, working commands, user preferences, blockers hit, durable context, conventions.",
    "- Skip: anything derivable from the code or git history, small talk, and details that only mattered inside this conversation.",
    ...(knownList
      ? [
          "- Already stored for this repo — do NOT output these or restatements of them:",
          knownList,
        ]
      : []),
    ...(prose
      ? [
          // The brief is its own block, so the rule about it is its own too.
          '- The REQUESTS block is what the user asked for in THIS session. Most of it scopes the current job and expires with it. Mine a `preference` from it ONLY when it names a tool, package, format or convention that outlives the task ("we use bun here", "no semicolons"); never from wording that scopes this job ("only touch src/", "do not create tests").',
        ]
      : []),
    // S1 (learn-from-failure). Measured on the bench: a session that failed
    // after 574 s and 33,287 tokens wrote ONE row, and it was a paraphrase of
    // the task brief. The prompt asked for "blockers hit" in a list of seven
    // words and never mentioned failure, so there was nothing to answer. What
    // makes this safe rather than noisy is that the failure list is not the
    // model's recollection — it is read from the tool ledger, and a lesson
    // whose citation is not in it is dropped before the write gate.
    ...(attested
      ? attested.length
        ? [
            "ATTESTED FAILURES (commands that ran in this session and FAILED, with no later pass. This is measured from the tool ledger, not your impression — it is the ONLY evidence of failure you have, and the only thing a lesson may be about):",
            ...attested.map((f) => `  - ${f}`),
            "",
            '- The most valuable thing a session that did not finish can teach a future one is what does not work. For each failure above worth a lesson, emit one row with type "blocker" whose content is a rule in the form: when <condition>, avoid <action>. Name a file or symbol, so the rule can be checked against the code later.',
            '- Every such row MUST carry "failure": the failing command, copied ONLY from the list above and EXACTLY as written there. A citation taken from anywhere else, or no citation at all, means the row is refused and dropped — never invent a failure, never cite one that later passed.',
            "- Say what was attempted and what the evidence showed. Do not state a cause you did not prove, and do not store the fix you did not verify: an unverified fix riding a later session is worse than no memory at all.",
            "- Emit no `blocker` for anything that did not fail here — not a style opinion, not a step that merely took a while, not the task brief.",
            "",
          ]
        : [
            // Explicit, because silence here reads as "no lesson-worthy failure
            // occurred", which is a different claim: this session ran no gate at
            // all, or every gate it ran passed.
            "No command failed in this session: emit no `blocker` lesson row.",
            "",
          ]
      : []),
    // Permission to emit fewer rows is what bounds deliberation. On the
    // reproducing fixture the same seat went 1,095 -> 3,084 completion tokens
    // and 19.7s -> 63.2s with this line removed, and the same rows out. It
    // also stops one instruction arriving as the same fact under three scope
    // names, which the store's 0.9 overlap floor does not see once the
    // wording differs.
    "- Few is better than full. If two candidates say the same thing about the same area, keep the one carrying the specific number, path, or command and drop the other. Never emit the same fact twice under different scope names.",
    "- If nothing is worth remembering, output [ ].",
    "",
    ...(prose
      ? [
          "Session work (what the agent did — this is the evidence):",
          redactSecrets(transcript),
          "",
          "REQUESTS (the user's brief for this session; constraints of THIS task, mostly not durable):",
          prose,
        ]
      : ["Transcript:", redactSecrets(transcript)]),
  ].join("\n");
}
