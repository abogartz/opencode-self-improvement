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
}

// Keywords are the vocabulary bridge for the strict-paraphrase wall, mined from
// the transcript the model just saw. Cap and shape mirror the store's own
// limits; the store normalises again at write, so this only has to stay
// junk-proof (capture.ts never imports the store — it stays dependency-free).
export const CAPTURE_KEYWORD_CAP = 8;

export const CAPTURE_KEYWORD_CHARS = 48;

// Prompt for the cheap capture model. The output contract is a bare JSON
// array so parseCandidates can trust it; anything else parses to [].
export function buildCapturePrompt(transcript: string, max = 3): string {
  return [
    "You mine one coding-agent session transcript for durable memories worth keeping across future sessions.",
    "",
    `Output ONLY a JSON array of at most ${max} objects (a fenced json block is fine), each:`,
    '{"type": "...", "scope": "...", "content": "...", "status": "...", "kw": ["...", "..."]}',
    "",
    "Rules:",
    `- type: one of ${TYPES.join(", ")}.`,
    "- scope: short area name (e.g. auth, api, build).",
    '- status: "open" for a live planning thread; otherwise "settled".',
    "- content: one self-contained fact, 20-600 characters, useful in a NEW session.",
    '- kw: 3-5 search keywords for how a DIFFERENT session would ask for this — synonyms and alternate names, other verb forms, the literal command or file name. They are indexed for retrieval and never shown to a model. Omit (or []) when the content already uses those words.',
    "- Keep: decisions made, working commands, user preferences, blockers hit, durable context, conventions.",
    "- Skip: anything derivable from the code or git history, small talk, and details that only mattered inside this conversation.",
    "- If nothing is worth remembering, output [ ].",
    "",
    "Transcript:",
    redactSecrets(transcript),
  ].join("\n");
}
