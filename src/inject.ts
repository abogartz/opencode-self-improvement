// Context surfaces. The system digest is TINY (≤2 lines): durable knowledge is
// pulled on demand, not pushed wholesale. Contextual pull rides grep/glob/read
// results (the same seam cbm-augment uses for graph nodes). Evidence is never
// injected (invariant I3).
import { isActive, loadAll, type Memory } from "./memory.ts";

export interface TransformOutput {
  system: string[];
}

export interface PullInput {
  tool?: unknown;
  args?: unknown;
}

export interface PullOutput {
  output?: unknown;
}

function dateOf(ts: string): string {
  return ts.split("T")[0];
}

export function formatMemory(m: Memory): string {
  return `- [${dateOf(m.ts)}] ${m.type}/${m.scope}: ${m.content}`;
}

function argText(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["pattern", "query", "path", "filePath", "command"]) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
}

export async function systemDigest(
  _input: unknown,
  output: TransformOutput,
): Promise<void> {
  const mems = (await loadAll()).filter(isActive);
  if (!mems.length) return;
  const latest = mems.map((m) => m.ts).sort().pop() ?? "?";
  output.system.push(
    "\n## Persistent memory (opencode-self-improvement)\n" +
      `${mems.length} durable memories; latest: ${latest}. ` +
      "Pull related items with memory_recall; contextual pull fires on grep/glob/read.",
  );
}

export async function contextualPull(input: PullInput, output: PullOutput): Promise<void> {
  const tool = typeof input.tool === "string" ? input.tool : "";
  if (!["grep", "glob", "read"].includes(tool)) return;
  const term = argText(input.args);
  if (!term) return;
  const query = new Set(words(term));
  const mems = (await loadAll()).filter(isActive);
  const scored = mems
    .map((m) => {
      const hay = new Set(words(`${m.scope} ${m.type} ${m.content}`));
      let score = 0;
      for (const w of query) if (hay.has(w)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!scored.length) return;
  const block = scored.map((s) => formatMemory(s.m)).join("\n");
  if (typeof output.output === "string") {
    output.output += `\n## Related durable memory (pull)\n${block}`;
  }
}
