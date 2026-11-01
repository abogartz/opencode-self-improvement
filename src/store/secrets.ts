// Small, conservative credential scrubber shared by capture egress and the
// write gate. Prefix patterns are intentionally limited to well-known token
// families; generic values are redacted only when assigned to a credential-
// named field and they look high-entropy, so ordinary identifiers survive.
export const REDACTED_SECRET = "[redacted]";

const PRIVATE_KEY_BLOCK =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g;
const PREFIXED_SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[po]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/g;
// A real bearer token has digits; prose like "Bearer authentication-scheme" doesn't.
const BEARER_SECRET = /\bBearer\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi;
const ASSIGNED_SECRET =
  /(\b(?:[A-Za-z][A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)|password)\b["']?\s*(?::|=)\s*["']?)([A-Za-z0-9+/_=.-]{16,})/gi;
// `API_KEY=process.env.OPENAI_API_KEY` names where the key lives; keep it.
const DOTTED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function looksHighEntropy(value: string): boolean {
  if (value.length < 16 || new Set(value).size < 10) return false;
  if (!/[0-9]/.test(value) || DOTTED_IDENTIFIER.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(value),
  ).length;
  return classes >= 3;
}

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text.replace(PRIVATE_KEY_BLOCK, REDACTED_SECRET);
  out = out.replace(PREFIXED_SECRET, REDACTED_SECRET);
  out = out.replace(BEARER_SECRET, REDACTED_SECRET);
  return out.replace(ASSIGNED_SECRET, (match, prefix: string, value: string) =>
    looksHighEntropy(value) ? `${prefix}${REDACTED_SECRET}` : match,
  );
}

export function containsSecret(text: string | undefined): boolean {
  return typeof text === "string" && redactSecrets(text) !== text;
}
