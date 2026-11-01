// Memory content may legitimately be multiline in the store, but every field
// rendered into a model-facing line must stay on that line. C0/C1 controls and
// Unicode line/paragraph separators all collapse through this one helper so
// renderers and write-boundary validators cannot drift.
const CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

export function flattenMemoryText(value: string): string {
  return value.replace(CONTROL_CHARS, " ");
}
