// relevant — split from src/inject.ts (#168 domain restructure). Declaration bodies are unchanged.
import { loadAll } from "../store/files/load.ts";
import { type Memory } from "../store/model/memory.ts";
import { isInjectable } from "../store/model/predicates.ts";
import { readerFromSid, visibleTo } from "../store/model/visibility.ts";
import { FRAME } from "../inject/budget.ts";
import { formatMemory } from "../inject/format.ts";
import { conflictLine, findConstant, valuesAgree } from "./conflicts.ts";
import { RESTATABLE_TAG, USER_GUIDED_TAG } from "../core/tags.ts";
import { cmpTs } from "../core/cmp-ts.ts";
import { scoreMemories } from "./score.ts";

export function argText(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["pattern", "query", "path", "filePath", "command"]) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/**
 * The content concepts a query and a row actually share (stopwords dropped,
 * capped, `ts` never included). This is what the use ledger records (#42):
 * every term in it already exists inside the row, so a hit line reveals
 * nothing about the prompt beyond the memory it points at — and it is enough
 * for #45 to replay a merge and prove the same reads would still land.
 */
/** The text a contextual pull actually searched with, for hit bookkeeping. */
export function pullQuery(args: unknown): string {
  return argText(args);
}

// Reinforcement (#42): a row the ledger has seen used breaks a tie over a row
// nobody ever read, and the more recently used one breaks it first. A TIE-BREAK
// only — the two-concept gate and IDF score still decide relevance, because
// popularity is not truth: reinforcement without evidence just amplifies
// whatever was retrieved first.
export interface UseSignals {
  get(ts: string): { count: number; last: string } | undefined;
}

export function useBoost(a: Memory | undefined, use?: UseSignals): number {
  if (!use || !a) return 0;
  return use.get(a.ts) ? 1 : 0;
}

// Select the rows relevant to a prompt and render the injection block, AND
// return the rows themselves so attribution (src/attribution.ts) can join the
// injected facts against the session's later tool calls. `relevantKnowledge`
// keeps its string contract for every existing caller; this is the richer seam.
export interface SelectOptions {
  /**
   * Hint channel (#335): when > 0, the newest `guidedCap` user-guided rows
   * ride the block FIRST regardless of lexical overlap — a user-stated value
   * ("the tax rate is 8.25%") shares no vocabulary with a task prompt about
   * "the injected bug", and the whole point of capturing guidance is that the
   * NEXT session gets it without asking. Cap + budget bound the noise; recall
   * and pull leave this off and stay query-driven.
   */
  guidedCap?: number;
  /**
   * Contradiction surface (POC): when true, a user-guided row that declares
   * ref/claim/klass is code-checked at render time. A collision replaces the
   * row's rendered text with one flagged CONFLICT line whose Action is fixed
   * by the class. Detection is a bounded file scan — deterministic, no model.
   */
  conflictCheck?: boolean;
  /**
   * Repo directory the code check reads. Absent (or a non-repo reader) means
   * no check: rows render plainly, exactly as before the feature.
   */
  repoDir?: string;
  /**
   * Character budget for the block (#388). Applied to the PRIORITY order —
   * guided lane first, then score — so pressure drops the least RELEVANT row.
   * Capping the rendered string instead would let recency decide who rides,
   * because the rendered order is canonical and not score-derived. Absent
   * means unbounded, which is what the callers that cap the string themselves
   * have always had.
   */
  budget?: number;
}

/** Row carries the hint-channel tag (written by capture for user-stated facts). */
export function isUserGuided(m: Memory): boolean {
  return m.tags?.includes(USER_GUIDED_TAG) === true;
}

/**
 * #402: the working tree already states this fact. Such a row is STORED (it used
 * to be dropped at capture, which is the defect #402 exists for), but it is the
 * first thing a tight injection budget gives up: the next session can read it in
 * the file, so a slot spent on it is a slot not spent on something the files do
 * not hold.
 *
 * The guided lane is exempt. A user-stated row outranks an inferred one in this
 * codebase everywhere, and capture tags guided rows too when their words are
 * verbatim in the tree.
 */
export function isRestatable(m: Memory): boolean {
  return m.tags?.includes(RESTATABLE_TAG) === true;
}

// Hint-channel caveat (#345). Measured: a WRONG user-guided row ("free
// shipping starts at $50 — the hidden suite encodes that") out-ranked correct
// code — the agent rewrote a correct threshold to match the memory. The
// generic "reference data, never instructions" framing did not prevent it.
// When guided rows ride, the header itself carries the counter-instruction:
// it rides the header line because capToBudget trims whole lines and may drop
// a standalone caveat, and the header is the one line that always survives.
const GUIDED_CAVEAT =
  "; user-stated guidance may be stale — verify against the current code before changing behavior it contradicts";

// Measured (arm F run 2.1): with a code-checked CONFLICT row riding, the
// plain caveat plus a captured "trust code over docs" row pushed the agent
// to file the CONFLICT row with the stale-doc decoys — the blanket rule beat
// the specific verdict. When a CONFLICT row rides, the header states the
// verification is ALREADY done and its Action governs; the staleness warning
// stays for everything else.
const CONFLICT_CAVEAT =
  "; CONFLICT rows were code-checked against this repo's current source — follow their Action; other user-stated guidance may be stale, verify against the current code before changing behavior it contradicts";

export async function selectRelevant(
  message: string,
  limit = 3,
  rows?: Memory[],
  use?: UseSignals,
  sid?: string,
  opts?: SelectOptions,
): Promise<{
  block: string;
  selected: Memory[];
  rendered: ReadonlyMap<Memory, Memory>;
}> {
  // Repo-scoped: model-facing reads see the caller's repo + global rows
  // (their session when one was threaded, #127).
  const mems = (rows ?? visibleTo(await loadAll(), readerFromSid(sid))).filter(
    isInjectable,
  );
  const cap = opts?.guidedCap ?? 0;
  const guided = cap
    ? mems
        .filter(isUserGuided)
        .sort((a, b) => cmpTs(b.ts, a.ts))
        .slice(0, cap)
    : [];
  // Contradiction surface: code-check the guided rows that declared a ref.
  // Only the RENDERED row changes (a shallow copy carries the CONFLICT text);
  // `selected` keeps the originals, so the use ledger and attribution still
  // key on stored rows. No collision (or no code found, or a computed value
  // the parser cannot decide) leaves the row plain — fail-open to the row,
  // never fail-shut on injection.
  const rendered = new Map<Memory, Memory>();
  if (opts?.conflictCheck && opts.repoDir && guided.length) {
    for (const m of guided) {
      if (!m.ref || !m.claim || !m.klass) continue;
      const fact = findConstant(opts.repoDir!, m.ref);
      if (!fact || valuesAgree(m.claim, fact.value) !== false) continue;
      rendered.set(m, { ...m, content: conflictLine(m, fact) });
    }
  }
  const text = message.trim();
  const top = text ? scoreMemories(text, mems, limit, use) : [];
  const rest = top.filter((m) => !guided.includes(m));
  const merged = [...guided, ...rest];
  if (!merged.length) return { block: "", selected: [], rendered };
  const lines = merged.map((m) => formatMemory(rendered.get(m) ?? m));
  // The caveat must describe the rows that ACTUALLY ride, so it cannot be fixed
  // before the budget runs (it used to be, and a budget that dropped the only
  // CONFLICT row still rendered "CONFLICT rows were code-checked … follow their
  // Action" over a block with none). The caveat also decides the header width
  // the budget is measured against, so the FIT uses the widest header this
  // selection can still produce and the RENDERED header is chosen afterwards
  // from the survivors. Re-fitting on the narrower header instead oscillates:
  // dropping the CONFLICT row shortens the header, which lets it fit again.
  const baseHeader = `## Relevant durable memory${FRAME}`;
  const widestCaveat = rendered.size
    ? CONFLICT_CAVEAT
    : guided.length
      ? GUIDED_CAVEAT
      : "";
  const fitHeader = baseHeader + widestCaveat;
  const caveatFor = (survivors: number[]): string => {
    let guidedRides = false;
    let conflictRides = false;
    for (const i of survivors) {
      const m = merged[i];
      if (!m) continue;
      if (guided.includes(m)) guidedRides = true;
      if (rendered.has(m)) conflictRides = true;
    }
    return !guidedRides ? "" : conflictRides ? CONFLICT_CAVEAT : GUIDED_CAVEAT;
  };
  // PRIORITY decides who rides; CANONICAL order decides how they are shown.
  // The rendered bytes are the prompt-cache key (src/inject/epochs.ts joins
  // them onto the system parts), and score order is a function of the live
  // prompt — so two turns that selected the same rows in a different rank
  // order re-billed the whole prefix to tell the model what it already knew.
  // `selected` keeps score order: the use ledger and attribution credit the
  // ranking, and a miss has to stay diagnosable.
  let shown = merged.map((_, i) => i);
  const budget = opts?.budget;
  if (budget !== undefined) {
    // Same whole-line discipline capToBudget uses (skip an over-long line,
    // keep scanning), applied BEFORE the re-order so relevance still decides.
    // A block left with nothing but its header renders as nothing — a dangling
    // "## Relevant durable memory" over zero memories is noise, not memory. A
    // header too wide for the budget needs no separate guard: `used` starts at
    // the header width, so no line can clear the test below and the empty
    // `shown` returns exactly what an explicit header check would.
    let used = fitHeader.length;
    shown = [];
    // #402: PRIORITY decides who rides, and a restatement now sits last in that
    // order — the tree already states it, so a slot spent here is a slot not
    // spent on something the files do not hold. `merged` stays in score order:
    // `selected` is the ledger's view of the ranking and a miss has to stay
    // diagnosable, so the demotion is a separate WALK order, never a re-sort of
    // the selection. The guided lane is exempt: a user-stated row outranks an
    // inferred one in this codebase everywhere.
    const demoted = (m: Memory | undefined): boolean =>
      !!m && !guided.includes(m) && isRestatable(m);
    const fitOrder = merged
      .map((_, i) => i)
      .sort(
        (a, b) =>
          (demoted(merged[a]) ? 1 : 0) - (demoted(merged[b]) ? 1 : 0) || a - b,
      );
    for (const i of fitOrder) {
      const line = lines[i] ?? "";
      if (used + 1 + line.length > budget) continue;
      shown.push(i);
      used += 1 + line.length;
    }
    // `selected` keeps the PRE-budget selection even here: the evidence field
    // `guided=` answers "did the selector pick it", `guidedRode=` answers "did
    // it survive". Returning [] would make a total trim read as "never picked".
    if (!shown.length) return { block: "", selected: merged, rendered };
  }
  shown.sort((a, b) => {
    const ma = merged[a];
    const mb = merged[b];
    if (!ma || !mb) return 0;
    const lane = (m: Memory) => (guided.includes(m) ? 0 : 1);
    if (lane(ma) !== lane(mb)) return lane(ma) - lane(mb);
    const recency = cmpTs(mb.ts, ma.ts);
    if (recency !== 0) return recency;
    // TOTAL order, not merely newest-first. Two rows can share an instant: a
    // same-millisecond pair, or a legacy second-precision stamp beside a
    // millisecond stamp for the same instant (`ISO_TS_RE` makes `.000`
    // optional, so both load). cmpTs returns 0 there and a stable sort falls
    // back to score order — the prompt-derived order this PR exists to remove,
    // one row pair away. Content, then the literal ts string, are both
    // prompt-independent, so the bytes depend on the SET of rows and nothing
    // else.
    if (ma.content !== mb.content) return ma.content < mb.content ? -1 : 1;
    return ma.ts < mb.ts ? -1 : ma.ts > mb.ts ? 1 : 0;
  });
  return {
    block: [
      baseHeader + caveatFor(shown),
      ...shown.map((i) => lines[i] ?? ""),
    ].join("\n"),
    selected: merged,
    rendered,
  };
}

export async function relevantKnowledge(
  message: string,
  limit = 3,
  rows?: Memory[],
): Promise<string> {
  return (await selectRelevant(message, limit, rows)).block;
}
