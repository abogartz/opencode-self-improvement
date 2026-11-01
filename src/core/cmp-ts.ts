// cmp-ts — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.


// Numeric compare, with the string compare kept as fallback for non-dates
// (the ledger hands "" when a row was never used). ISO strings agree with
// Date.parse only while the FORMAT agrees: a legacy second-precision stamp
// ("…:01Z") and a millisecond stamp ("…:01.000Z") for the same instant order
// wrong as strings, which would silently mis-rank the recency tie-break.
// Exported for consolidate.ts — cluster ordering must not disagree with the
// ranking it is merging.
export function cmpTs(a: string, b: string): number {
  const na = Date.parse(a);
  const nb = Date.parse(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}
