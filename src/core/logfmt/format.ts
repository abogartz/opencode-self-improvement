// format — split from src/logfmt.ts (#168 domain restructure). Declaration bodies are unchanged.


export const IS_WINDOWS = process.platform === "win32";

export type Fields = Record<string, unknown>;

// Escapes for quoted values. One record is one line, so a raw newline inside a
// value would end the record early and the rest of the value would be read
// back as a separate line of fields. Backslash is escaped too, so a value
// ending in `\` cannot swallow its closing quote.
const ESCAPE: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t" };

const UNESCAPE: Record<string, string> = { "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" };

// Lines written before these escapes existed stored backslashes raw, so in an
// old line `C:\new` is a backslash and an `n`, not a newline. A line whose
// values use the escapes ends with this marker, and only fields before it are
// unescaped; everything else is read the old way, where only `\"` is an escape.
// Fields after the marker were appended by an older version (supersede adds
// fields to the end of an existing line). Lines without backslashes, newlines
// or tabs read the same either way, so they don't carry the marker.
const MARKER = "esc";

const MARKER_VALUE = "1";

export function quote(value: unknown): string {
  const s = String(value);
  if (s === "") return '""';
  return /[\s"=]/.test(s) ? `"${s.replace(/[\\"\n\r\t]/g, (c) => ESCAPE[c])}"` : s;
}

export function formatLine(fields: Fields): string {
  const parts: string[] = [];
  let escaped = false;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || k === MARKER) continue;
    const q = quote(v);
    if (q.startsWith('"') && /[\\\n\r\t]/.test(String(v))) escaped = true;
    parts.push(`${k}=${q}`);
  }
  if (escaped) parts.push(`${MARKER}=${MARKER_VALUE}`);
  return parts.join(" ");
}

// Unescape a quoted logfmt value and read it back. Unknown sequences are kept
// as written.
function unquote(s: string): string {
  return s.replace(/\\(.)/g, (seq, c: string) => UNESCAPE[c] ?? seq);
}

function unquoteLegacy(s: string): string {
  return s.replace(/\\"/g, '"');
}

export function parseLine(line: string): Fields | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("=")) return null;
  const tokens: [string, string][] = [];
  const re = /([A-Za-z0-9_.-]+)=("(?:[^"\\]|\\.)*"|[^\s]*)/g;
  for (;;) {
    const m = re.exec(trimmed);
    if (!m) break;
    tokens.push([m[1], m[2]]);
  }
  const marker = tokens.findIndex(([k, v]) => k === MARKER && v === MARKER_VALUE);
  const fields: Fields = {};
  tokens.forEach(([key, value], i) => {
    if (key === MARKER) return;
    let raw = value;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      raw = (i < marker ? unquote : unquoteLegacy)(raw.slice(1, -1));
    }
    fields[key] = raw;
  });
  // parse booleans/numbers as strings is fine; callers coerce.
  return fields;
}

export function bracketList(items: string[]): string {
  return `[${items.join(",")}]`;
}
