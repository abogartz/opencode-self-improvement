// Context surfaces. The system digest is TINY (≤2 lines): durable knowledge is
// pulled on demand, not pushed wholesale. Deterministic memory-first injection
// rides chat.message (synthetic parts), so relevant knowledge is in the model's
// context before it chooses any tool. Contextual pull rides grep/glob/read
// results. Evidence is never injected (invariant I3).
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

function scoreMemories(term: string, mems: Memory[], limit: number): Memory[] {
  const query = new Set(words(term));
  if (!query.size) return [];
  return mems
    .map((m) => {
      const hay = new Set(words(`${m.scope} ${m.type} ${m.content}`));
      let score = 0;
      for (const w of query) if (hay.has(w)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.m);
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
      "Check memory_recall BEFORE grepping or reading, for build/test/lint commands, decisions, and conventions. Relevant memories are also auto-injected when your message matches.",
  );
}

export async function relevantKnowledge(message: string, limit = 3): Promise<string> {
  const text = message.trim();
  if (!text) return "";
  const mems = (await loadAll()).filter(isActive);
  const top = scoreMemories(text, mems, limit);
  if (!top.length) return "";
  return `## Relevant durable memory\n${top.map(formatMemory).join("\n")}`;
}

export async function contextualPull(input: PullInput, output: PullOutput): Promise<void> {
  const tool = typeof input.tool === "string" ? input.tool : "";
  if (!["grep", "glob", "read"].includes(tool)) return;
  const term = argText(input.args);
  if (!term) return;
  const mems = (await loadAll()).filter(isActive);
  const top = scoreMemories(term, mems, 3);
  if (!top.length) return;
  const block = top.map(formatMemory).join("\n");
  if (typeof output.output === "string") {
    output.output += `\n## Related durable memory (pull)\n${block}`;
  }
}
