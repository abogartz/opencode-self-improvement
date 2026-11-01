// time — split from src/config.ts (#168 domain restructure). Declaration bodies are unchanged.


export function dateStr(d: Date = new Date()): string {
  return d.toISOString().split("T")[0];
}
