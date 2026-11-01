// pull — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
import { loadAll } from "../store/files/load.ts"
import { type Memory } from "../store/model/memory.ts"
import { isInjectable } from "../store/model/predicates.ts"
import { readerFromSid, visibleTo } from "../store/model/visibility.ts";
import { injectBudget } from "../core/config/budgets.ts";
import { FRAME, capToBudget, injectedRows } from "./budget.ts";
import { formatMemory } from "./format.ts";
import { type UseSignals, argText } from "../recall/relevant.ts";
import { scoreMemories } from "../recall/score.ts";

export interface TransformOutput {
  system: string[];
}

export interface PullInput {
  tool?: unknown;
  args?: unknown;
  // The session the pull runs FOR (#127): resolved to an immutable Reader at
  // entry so the loadAll await below cannot drift into another session's repo.
  sessionID?: unknown;
}

export interface PullOutput {
  output?: unknown;
}

export async function contextualPull(
  input: PullInput,
  output: PullOutput,
  budget = injectBudget(),
  use?: UseSignals,
): Promise<Memory[]> {
  const tool = typeof input.tool === "string" ? input.tool : "";
  if (!["grep", "glob", "read"].includes(tool)) return [];
  const term = argText(input.args);
  if (!term) return [];
  // Repo-scoped: model-facing reads see the CALLER's repo + global rows —
  // the pull's own sessionID, resolved before the store read (#127).
  const mems = visibleTo((await loadAll()).filter(isInjectable), readerFromSid(input.sessionID));
  const top = scoreMemories(term, mems, 3, use);
  if (!top.length) return [];
  // Held to the injection budget too: three long rows were ~12 KB per call.
  const block = capToBudget(`## Related durable memory (pull)${FRAME}\n${top.map(formatMemory).join("\n")}`, budget);
  if (block && typeof output.output === "string") {
    output.output += `\n${block}`;
    // What the ledger counts is what actually rode the result — the budget can
    // drop rows, and crediting a memory the model never saw would inflate it.
    return injectedRows(block, top);
  }
  return [];
}
