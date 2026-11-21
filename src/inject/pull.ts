// pull — split from src/inject.ts. Declaration bodies are unchanged.
import { loadAll } from "../store/files/load.ts";
import { type Memory } from "../store/model/memory.ts";
import { isInjectable } from "../store/model/predicates.ts";
import { readerFromSid, visibleTo } from "../store/model/visibility.ts";
import { injectBudget } from "../core/config/budgets.ts";
import { FRAME, fittingLineIndices } from "./budget.ts";
import { formatMemory } from "./format.ts";
import { type UseSignals, argText } from "../recall/relevant.ts";
import { scoreMemories } from "../recall/score.ts";

// The pull block's first line. Exported so a receipt can find the block in
// the tool-result the host is about to send (src/inject/pull-receipts.ts).
export const PULL_HEADER = `## Related durable memory (pull)${FRAME}`;

export interface TransformOutput {
  system: string[];
}

export interface PullInput {
  tool?: unknown;
  args?: unknown;
  // The session the pull runs FOR: resolved to an immutable Reader at
  // entry so the loadAll await below cannot drift into another session's repo.
  sessionID?: unknown;
}

export interface PullOutput {
  output?: unknown;
}

// Put the pull onto the host's tool result so the model actually reads it.
// WHICH field the host forwards is measured, not assumed. On opencode v2.3.0
// (probed through e2e/support/harness.ts against the real host) `result.content`
// is an ARRAY of `{type:"text",text}` parts and mutating a text part changes the
// next request; mutating `result.output` — the file-attachment object
// `{type,uri,name,content,encoding,mime}` — does not. Older hosts passed a plain
// string in `content`, which is the shape this function was originally written
// against, and a string `output` is covered too.
//
// Returns true only when the bytes were placed. A pull that found nowhere to
// write showed the model nothing. Placement is still not delivery: a later
// plugin's hook can trim the result, so the caller only HOLDS the credit and
// the next request settles it (src/inject/pull-receipts.ts).
export function writePullIntoResult(
  result: unknown,
  before: string,
  after: string,
): boolean {
  if (!result || typeof result !== "object") return false;
  // Compare the two local strings to isolate the suffix this hook appended.
  if (!after.startsWith(before)) return false;
  const block = after.slice(before.length);
  if (!block) return false;
  const r = result as { content?: unknown };
  if (typeof r.content === "string") {
    r.content += block;
    return true;
  }
  if (Array.isArray(r.content)) {
    // Append to the LAST text part: the pull is commentary on the output, so it
    // belongs after it, and a result can carry several parts.
    for (let i = r.content.length - 1; i >= 0; i--) {
      const part = r.content[i] as { text?: unknown } | undefined;
      if (part && typeof part === "object" && typeof part.text === "string") {
        part.text += block;
        return true;
      }
    }
    r.content.push({ type: "text", text: block });
    return true;
  }
  return false;
}

// What a pull is allowed to search. Every field exists because it was measured
// before being changed (bench/runners/pull-precision.ts), not because it seemed
// reasonable: a pull bolts text onto a tool result the model did not ask for, so
// the cost of a wrong pull is paid by every later turn.
export interface PullScope {
  /** Tool results that may carry a pull. */
  tools: readonly string[];
  /** Whether the tool's own output joins the query, not just its arguments. */
  includeOutput: boolean;
  /** How many characters of it. A 40 KB file dump is not a query. */
  outputChars: number;
  /**
   * ALSO search the arguments alone and merge, argument matches first. A longer
   * query raises the scorer's two-concept gate, so a combined search can DROP a
   * row the model's own words already matched; merging recovers it without
   * giving up the reach the output bought. Measured, not assumed:
   * bench/runners/pull-precision.ts.
   */
  argsUnion?: boolean;
}

/**
 * The shipped arm: the arguments AND the first 512 characters of the result,
 * for grep/glob/read, with the arguments-only search merged back in first.
 *
 * Chosen by measurement, not taste — bench/runners/pull-precision.ts
 * (2026-11-20), committed recall dataset, stores of 52/200/800, and the shape
 * held at all three (store = 200 below):
 *
 *   arm              R@1 arg  R@3 arg  R@1 out   noise% ordinary   bytes/call
 *   args-only          98.6      100       0            65%            122
 *   + output, no merge 92.9     94.3    18.8             0%            216
 *   THIS ARM           98.6      100    18.8            65%            252
 *
 * The class it exists for — a fact keyed to something the model only sees in
 * the tool's OUTPUT (an error string, a symbol in a file body) — goes from
 * unreachable to 18.8% R@1 (17.9% at store 800) without moving the class that
 * already worked. The merge is what buys that: a combined query is longer, and
 * a longer query raises the scorer's two-concept gate, so a precise search
 * ("table_manager.save") otherwise loses its exact-match row to boilerplate
 * output ("grep results"). That is not hypothetical — it broke
 * test/host/scenarios.test.ts's I3 case the first time.
 *
 * The merge takes slots in ORDER: argument matches are placed first and the
 * combined matches fill what is left, not the reverse. Three slots is the whole
 * delivery, so an order that appends argument matches can only recover a row
 * when the output matches nothing — a grep whose output names three other rows
 * leaves the exact match past the cap. This scope's own bench cannot see the
 * difference: both orders score byte-identical at stores 200 and 800, because
 * no fixture call pairs a precise argument with three output-matching rows.
 * Where the bench DOES see it is the rejected `+ shell` arm — first choice
 * costs it 7.7 points of output-only R@1 (45.3 → 37.6 at store 200), because
 * there the arguments usually fill all three slots. That is the trade stated
 * plainly: intent outranks output, and it is paid for in reach only on calls
 * where the arguments already match three rows. The case the bench is blind to
 * is pinned by test/inject/pull-scope.test.ts.
 *
 * Measured and REJECTED, so the next reader does not "improve" it back:
 *   + shell        doubles the reach (R@1 out 45.3 merged, 43.9 unmerged at
 *                  store 800) but takes ordinary-traffic noise to 100% of
 *                  no-gold calls: every plain read and command
 *                  gets a block bolted onto it.
 *   no merge       looks quiet (0% noise) only because its misses are silences —
 *                  miss-abstain 100%. It spends 5.7 points of arg-visible R@3 to
 *                  buy the same output reach.
 *   error-gated    output only on a failure signal: 26% R@1 out, but 100% noise
 *                  on ordinary traffic once shell is in scope, and no better
 *                  than this arm without it.
 *   outputChars    128 / 512 / 2000 scored identically: the fixture puts the
 *                  signal early in the output, so this bench cannot rank them.
 *                  512 is a bound on cost, not a tuned value.
 * Noise is the share of NO-GOLD calls that pull at least one row. At 65% that is
 * the pre-existing behaviour of the arguments-only arm, inherited unchanged: this
 * change adds reach, it does not add spam. Cutting that number is the next
 * measured step, not this one.
 */
export const PULL_SHIPPED: PullScope = {
  tools: ["grep", "glob", "read"],
  includeOutput: true,
  outputChars: 512,
  argsUnion: true,
};

/**
 * The arm from plugin options, so a user can dial the behaviour back without a
 * code change:
 *   pullOutputChars: 0      → arguments only (the pre-2026-11 behaviour)
 *   pullTools: ["read"]     → only reads may carry a pull
 *   pullTools: []           → no tool result carries a pull at all
 *
 * An empty list is the only opt-out this channel has, and a pull bolts text
 * onto results the model did not ask for, so it deserves one: an empty list is
 * a decision someone typed. A value that merely FAILS to parse — a string
 * where a list belongs, a list of numbers — is a typo, and a typo falls back
 * to the shipped arm rather than switching delivery off. Both paths say what
 * they did through `warn`, because a config line that does nothing is worse
 * than one that refuses.
 */
export function pullScopeFrom(
  options: Record<string, unknown> | undefined,
  warn?: (message: string) => void,
): PullScope {
  const chars = options?.pullOutputChars;
  const tools = options?.pullTools;
  const charsOk =
    chars === undefined ||
    (typeof chars === "number" && Number.isFinite(chars) && chars >= 0);
  if (!charsOk && warn) {
    warn(
      `pullOutputChars must be a non-negative number; got ${JSON.stringify(chars) ?? String(chars)}. Using ${PULL_SHIPPED.outputChars}.`,
    );
  }
  const outChars = charsOk
    ? chars === undefined
      ? PULL_SHIPPED.outputChars
      : Math.min(Math.floor(chars as number), 4096)
    : PULL_SHIPPED.outputChars;
  // `undefined` (unset) and `[]` (explicitly nothing) are different inputs, so
  // the raw list is kept apart from the filtered one.
  const raw = Array.isArray(tools) ? tools : undefined;
  if (tools !== undefined && raw === undefined && warn) {
    warn(
      `pullTools must be a list of tool names; got ${JSON.stringify(tools) ?? String(tools)}. Using the default ${PULL_SHIPPED.tools.join(", ")}.`,
    );
  }
  const toolList = raw
    ? raw.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
  if (raw && raw.length > 0 && toolList.length === 0 && warn) {
    warn(
      `pullTools held no usable tool name; got ${JSON.stringify(tools)}. Using the default ${PULL_SHIPPED.tools.join(", ")}.`,
    );
  }
  return {
    tools:
      raw && raw.length === 0
        ? []
        : toolList.length
          ? toolList
          : PULL_SHIPPED.tools,
    includeOutput: outChars > 0,
    outputChars: outChars,
    // Only meaningful when the output joins the query; without it the two
    // searches are the same search.
    argsUnion: outChars > 0,
  };
}

/**
 * The query one tool call searches memory with. Args first: the model's own
 * intent outranks whatever the tool happened to print. Returns "" for a tool
 * outside the scope, which is how the pull stays off the write path.
 */
export function pullQueryFor(
  tool: string,
  args: unknown,
  resultText: string,
  scope: PullScope,
): string {
  if (!scope.tools.includes(tool)) return "";
  const arg = argText(args);
  if (!scope.includeOutput) return arg;
  const head = resultText.slice(0, scope.outputChars).trim();
  return arg && head ? `${arg}\n${head}` : arg || head;
}

export async function contextualPull(
  input: PullInput,
  output: PullOutput,
  budget = injectBudget(),
  use?: UseSignals,
  scope: PullScope = PULL_SHIPPED,
  header = PULL_HEADER,
): Promise<Memory[]> {
  const tool = typeof input.tool === "string" ? input.tool : "";
  const own = typeof output.output === "string" ? output.output : "";
  const term = pullQueryFor(tool, input.args, own, scope);
  if (!term) return [];
  // Repo-scoped: model-facing reads see the CALLER's repo + global rows —
  // the pull's own sessionID, resolved before the store read.
  const mems = visibleTo(
    (await loadAll()).filter(isInjectable),
    readerFromSid(input.sessionID),
  );
  const top = scoreMemories(term, mems, 3, use);
  // Merge the arguments-only search AHEAD of the combined one. The combined query
  // is longer, and a longer query raises the scorer's two-concept gate, so the
  // row the model's OWN words matched can fall out of a combined search that
  // would otherwise be a strict improvement. Argument matches keep first choice:
  // the model's intent outranks whatever the tool happened to print.
  //
  // First choice, not last refusal. Three slots is the whole delivery, so an
  // order that appends argument matches after the combined ones recovers them
  // only when the output matches nothing — a grep whose output names three other
  // rows leaves the exact match past the cap. That is the regression the review
  // on PR 457 caught, pinned by test/inject/pull-scope.test.ts.
  const merged = scope.argsUnion
    ? (() => {
        const args = argText(input.args);
        if (!args || args === term) return top;
        const byArgs = scoreMemories(args, mems, 3, use);
        const seen = new Set(byArgs.map((m) => m.ts));
        return [...byArgs, ...top.filter((m) => !seen.has(m.ts))].slice(0, 3);
      })()
    : top;
  if (!merged.length) return [];
  // Held to the injection budget too: three long rows were ~12 KB per call.
  if (typeof output.output !== "string") return [];
  const lines = merged.map(formatMemory);
  const kept = fittingLineIndices(lines, budget - header.length);
  if (!kept.length) return [];
  output.output += `\n${[header, ...kept.map((i) => lines[i])].join("\n")}`;
  return kept.map((i) => merged[i]);
}
