// Capture-trigger comparison (issue #41 acceptance): retrieval hit-rate of
// capture-at-idle vs capture-at-compaction rows, deterministic stand-in for
// the month-long production A/B the evidence lines enable.
//
// WHAT IS REAL here: the shipped plugin end-to-end (test/harness fakes drive
// the actual session.compaction hook and the actual session.idle listener),
// the actual 4-gate write pipeline, the actual store files, and the actual
// shipped retrieval matcher (scoreMemories from src/inject.ts, k=3 as in
// bench/recall-quality.ts). Stores are populated ONLY through auto-capture
// writes plus equal hand-seeded distractors on both sides (conservation).
//
// WHAT IS SIMULATED (stated honestly, per epic #68):
//   - the capture MODEL — a scripted extractor: the canned reply names every
//     fact whose text is present in the prompt; control 6 asserts the prompt
//     really carries each of those facts, so the canned reply is equivalent
//     to a model that reads and mines faithfully. The comparison therefore
//     measures what each TRIGGER puts into reach, not miner quality.
//   - the Compaction Cliff (arXiv:2608.22752: one compaction round retains
//     53% of exact-wording rules) — the IDLE world models a long session that
//     compacted BEFORE going idle: session.context then carries a
//     deterministic 53% survivor subset of the facts (LCG, no Math.random);
//     the COMPACTION world mines the full pre-compaction transcript at the
//     hook. Real retention varies per session; the paper's number
//     parameterizes the simulation.
//
// MUST GO RED (exit 1): if any control fails — in particular the negative
// control (capture OFF scores > 0) and the trigger comparison (compaction
// scores no better than OFF). ON src WITHOUT the compaction trigger, the
// compaction world captures nothing and control 2 goes red. A harness that
// cannot fail does not count.
//
//   bun bench/capture-trigger-compare.ts
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDir } from "../src/core/config/paths.ts"
import { dateStr } from "../src/core/time.ts";
import { formatLine, parseLine } from "../src/core/logfmt/format.ts";
import { loadAll } from "../src/store/files/load.ts"
import { type Memory } from "../src/store/model/memory.ts"
import { isActive } from "../src/store/model/predicates.ts";
import { resetState } from "../src/core/state.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import { scoreMemories, words } from "../src/recall/score.ts";
import { buildStore, lcg, MEMORIES, QUERIES } from "./recall-dataset.ts";
import { loadPlugin } from "../test/harness.ts";

// --- scenario construction ----------------------------------------------------

// Gold facts the "session" mined: dataset memories with no path-shaped
// tokens, and no decision/preference type — see the distractor note: captured
// decisions are review-gated against same-scope decisions (including earlier
// candidates from the SAME capture), which measures GATE-3's merge policy,
// not the trigger.
const GOLDS = MEMORIES.filter(
  (m) => !/\w\/\w/.test(m.content) && m.type !== "decision" && m.type !== "preference",
).slice(0, 24);
const GOLD_IDS = new Set(GOLDS.map((m) => m.id));
const QUERIES_HERE = QUERIES.filter((q) => GOLD_IDS.has(q.gold));
const byId = new Map(GOLDS.map((m) => [m.id, m]));

// Equal distractor field for every world (topically adjacent, never gold).
// Two exclusions, applied identically to every world, keep the measurement on
// the TRIGGER rather than on the moat:
//   - no mutated near-twins of golds (they correctly BLOCK a gold write as
//     superseded_overlap — dedup, not a trigger signal; rule 3 stays intact:
//     originals m25+ and their variants keep the ranking competition real);
//   - no decision/preference rows at all: the gate review-gates EVERY captured
//     decision against ANY same-scope rival decision (conflictProne), which
//     measures GATE-3's merge policy, not capture. With rivals excluded the
//     control below asserts every mined fact promotes, so a future gate change
//     that silently stops promoting captured facts turns this bench red.
const DISTRACTORS = buildStore(600)
  .filter((m) => !GOLD_IDS.has(m.id.split("#")[0]!) && m.type !== "decision" && m.type !== "preference")
  .slice(0, 150);

// The simulated cliff: 53% of exact-wording rules survive one compaction
// (arXiv:2608.22752). Deterministic pick, same LCG contract as the dataset.
const KEEP_RATE = 0.53;
function cliffSurvivors(): number[] {
  const rand = lcg(20261025);
  const idx = GOLDS.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, Math.round(GOLDS.length * KEEP_RATE)).sort((a, b) => a - b);
}
const SURVIVORS = cliffSurvivors();

const factMessages = (facts: { content: string; scope: string }[]) =>
  facts.map((f) => ({
    role: "user",
    content: `${f.content} That came up while working in ${f.scope}; it mattered for the rest of the session.`,
  }));
const factCandidates = (facts: { type: string; scope: string; content: string }[]) =>
  JSON.stringify(facts.map((f) => ({ type: f.type, scope: f.scope, content: f.content })));

// --- world runner ---------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("bench waitFor timed out");
    await sleep(10);
  }
}

function evidenceEvs(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseLine(l))
    .filter((f): f is Record<string, unknown> => f !== null)
    .map((f) => String(f.ev ?? ""));
}

interface WorldResult {
  name: string;
  rows: Memory[];
  capturedRows: number;
  generateCalls: number;
  prompts: string[];
}

async function runWorld(
  name: string,
  trigger: "off" | "compaction" | "idle",
  scratch: string,
): Promise<WorldResult> {
  const root = mkdtempSync(join(scratch, `world-${name}-`));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  setRepoScope(null);
  resetState();

  const liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  // Equal hand-seeded competition on every side (never captured, never gold).
  const storeFile = join(process.env.OPENCODE_MEMORY_DIR, `${dateStr()}.logfmt`);
  mkdirSync(join(process.env.OPENCODE_MEMORY_DIR), { recursive: true });
  appendFileSync(
    storeFile,
    DISTRACTORS.map((d) =>
      formatLine({ ts: `2026-01-01T00:00:0${(d.id.length % 9) + 1}.000Z`, type: d.type, scope: d.scope, content: d.content, status: "settled" }),
    ).join("\n") + "\n",
  );

  const loaded = await loadPlugin(liveRoot, trigger === "off" ? {} : {
    autoCapture: true,
    captureModel: "fake/model",
    captureMax: 30,
  });

  // Ground the session so ref-free candidates promote through the gate's
  // behavior-grounding path, exactly as the capture unit tests do.
  const sid = `ses-bench-${name}`;
  await loaded["tool.execute.after"](
    { tool: "read", sessionID: sid, callID: "C1", args: { filePath: "x.ts" } },
    { title: "read", output: "content", metadata: {} },
  );

  const mined = trigger === "idle" ? SURVIVORS.map((i) => GOLDS[i]!) : GOLDS;
  loaded.capture.generate.response = factCandidates(mined);
  const evFile = join(evidenceDir(), `${dateStr()}.logfmt`);

  if (trigger === "compaction" || trigger === "off") {
    // A long session hits the context limit: the compaction hook fires while
    // the FULL transcript is still in the payload.
    await loaded.sessionHooks["compaction"]?.({
      sessionID: sid,
      system: [],
      messages: factMessages(GOLDS),
    });
  } else {
    // Same session shape, but the compaction happened first and the session
    // only THEN went idle: context now carries the post-cliff survivors.
    loaded.capture.context.messages = factMessages(mined);
    loaded.capture.events.push({ type: "session.idle", data: { sessionID: sid } });
  }

  if (trigger === "off") {
    await sleep(150);
  } else {
    const stem = trigger === "compaction" ? "auto_capture_compaction" : "auto_capture";
    try {
      await waitFor(() => {
        const evs = evidenceEvs(evFile);
        const rejected = evs.filter(
          (e) => e === `${stem}_blocked` || e === `${stem}_collapsed`,
        ).length;
        if (rejected) {
          throw new Error(
            `bench: the write gate rejected ${rejected} mined ${stem} facts — distractor design or moat behavior ` +
              "changed; this comparison no longer isolates the trigger. Re-read the evidence log before trusting numbers.",
          );
        }
        return evs.filter((e) => e === `${stem}_promoted`).length >= mined.length;
      });
    } catch (err) {
      // A TIMEOUT means the capture never completed — on src without the
      // compaction trigger the compaction world lands here with zero
      // captures, and the controls below report the honest RED (a raw crash
      // before the report would hide which control failed). Any other error
      // (the moat canary) stays loud.
      if (!String((err as Error)?.message ?? "").includes("timed out")) throw err;
    }
  }

  const rows = (await loadAll()).filter(isActive);
  const capturedRows = rows.filter((m) => m.tags?.includes("auto-capture")).length;
  const result: WorldResult = {
    name,
    rows,
    capturedRows,
    generateCalls: loaded.capture.generate.calls.length,
    prompts: loaded.capture.generate.calls.map((c) => c.prompt),
  };
  await loaded.cleanup();
  return result;
}

// --- scoring: shipped matcher, k=3 (same protocol as bench/recall-quality) -----

const STOP = new Set(
  "a an and are at be but by can did do does for from had has have how i in into is it its me my no not of on or our so than that the their them then there these they this to us was we were what when where which who why will with you your run runs getting want needs right back yet also just still ever".split(" "),
);
const contentTokens = (t: string) => new Set(words(t).filter((x) => !STOP.has(x)));
function measureClass(query: string, gold: { scope: string; type: string; content: string }): string {
  const gt = contentTokens(`${gold.scope} ${gold.type} ${gold.content}`);
  let shared = 0;
  for (const t of contentTokens(query)) if (gt.has(t)) shared++;
  return shared >= 2 ? "lexical" : shared === 1 ? "near" : "strict";
}

interface WorldScore {
  n: number;
  hits: number;
  goldMissing: number;
  rankMiss: number;
  byClass: Map<string, { n: number; hits: number }>;
}

function scoreWorld(w: WorldResult): WorldScore {
  const s: WorldScore = { n: 0, hits: 0, goldMissing: 0, rankMiss: 0, byClass: new Map() };
  for (const q of QUERIES_HERE) {
    const gold = byId.get(q.gold)!;
    const present = w.rows.some((m) => m.content === gold.content);
    const ranked = scoreMemories(q.q, w.rows, w.rows.length);
    const hit = present && ranked.slice(0, 3).some((m) => m.content === gold.content);
    s.n++;
    if (hit) s.hits++;
    else if (!present) s.goldMissing++;
    else s.rankMiss++;
    const cls = measureClass(q.q, gold);
    const c = s.byClass.get(cls) ?? { n: 0, hits: 0 };
    c.n++;
    if (hit) c.hits++;
    s.byClass.set(cls, c);
  }
  return s;
}

// --- run ------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "osi-trigger-compare-"));
let failed = false;
try {
  const worlds: Array<{ w: WorldResult; s: WorldScore }> = [];
  for (const spec of [
    { name: "off", trigger: "off" as const },
    { name: "compaction", trigger: "compaction" as const },
    { name: "idle", trigger: "idle" as const },
  ]) {
    const w = await runWorld(spec.name, spec.trigger, scratch);
    worlds.push({ w, s: scoreWorld(w) });
  }
  const [off, compact, idle] = worlds as [
    { w: WorldResult; s: WorldScore },
    { w: WorldResult; s: WorldScore },
    { w: WorldResult; s: WorldScore },
  ];

  const pct = (h: number, n: number) => (n ? `${Math.round((h / n) * 100)}%` : "-");
  const lines: string[] = [];
  lines.push("# Capture on compaction vs capture on idle — measured retrieval hit-rate");
  lines.push("");
  lines.push(
    `${QUERIES_HERE.length} queries over ${GOLDS.length} session facts (committed dataset), ` +
      `${DISTRACTORS.length} equal distractors per store, shipped matcher, k=3. ` +
      `Cliff simulation: idle world mines AFTER a compaction that retained ${SURVIVORS.length}/` +
      `${GOLDS.length} facts (${Math.round(KEEP_RATE * 100)}% per arXiv:2608.22752); compaction ` +
      "world mines the full transcript AT the hook. Capture model: scripted faithful extractor " +
      "(prompt containment asserted by control 6).",
  );
  lines.push("");
  lines.push("| world | trigger | captured rows | R@3 | gold missing (lost to cliff) | rank miss | model calls |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const { w, s } of worlds) {
    lines.push(
      `| ${w.name} | ${w.name === "idle" ? "session.idle" : w.name === "compaction" ? "session.compaction" : "none (control)"} | ` +
        `${w.capturedRows} | ${pct(s.hits, s.n)} (${s.hits}/${s.n}) | ${s.goldMissing} | ${s.rankMiss} | ${w.generateCalls} |`,
    );
  }
  lines.push("");
  lines.push(`| query class | ${worlds.map(({ w }) => `${w.name} R@3`).join(" | ")} |`);
  lines.push("| --- | ---: | ---: | ---: |");
  for (const cls of ["lexical", "near", "strict"]) {
    const cells = worlds.map(({ s }) => {
      const c = s.byClass.get(cls) ?? { n: 0, hits: 0 };
      return `${pct(c.hits, c.n)} (${c.hits}/${c.n})`;
    });
    lines.push(`| ${cls} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  const controls: string[] = [];
  const check = (ok: boolean, label: string) => {
    controls.push(`${ok ? "PASS" : "FAIL"} — ${label}`);
    if (!ok) failed = true;
  };
  check(
    off.s.hits === 0,
    `negative control: capture OFF hit-rate is 0 (got ${off.s.hits}/${off.s.n}) — a harness that cannot fail does not count`,
  );
  check(
    compact.s.hits > off.s.hits,
    `trigger earns its tokens: capture-at-compaction (${compact.s.hits}/${compact.s.n}) beats OFF (${off.s.hits}/${off.s.n}) — RED on src without the compaction trigger`,
  );
  check(
    SURVIVORS.length < GOLDS.length && idle.s.goldMissing > 0,
    `cliff simulation bites: ${SURVIVORS.length}/${GOLDS.length} facts survive, idle lost ${idle.s.goldMissing} queryable golds`,
  );
  check(
    compact.s.hits > idle.s.hits,
    `the cliff is the difference: compaction (${compact.s.hits}/${compact.s.n}) beats idle-after-compaction (${idle.s.hits}/${idle.s.n})`,
  );
  check(
    compact.w.capturedRows === GOLDS.length && idle.w.capturedRows === SURVIVORS.length && off.w.capturedRows === 0,
    `conservation: captured rows == mined facts (compaction ${compact.w.capturedRows}/${GOLDS.length}, idle ${idle.w.capturedRows}/${SURVIVORS.length}, off ${off.w.capturedRows}/0) — nothing else wrote rows`,
  );
  const contained = (w: WorldResult, facts: { content: string }[]) =>
    w.generateCalls === 1 && facts.every((f) => w.prompts[0]!.includes(f.content));
  check(
    contained(compact.w, GOLDS) && contained(idle.w, SURVIVORS.map((i) => GOLDS[i]!)) && off.w.generateCalls === 0,
    "prompt containment: every mined fact really rode the capture prompt (the scripted model reads what the trigger hands it)",
  );
  lines.push("## Controls");
  lines.push("");
  for (const c of controls) lines.push(`- ${c}`);
  lines.push("");
  lines.push(
    "Production follow-through: evidence lines `auto_capture_*` (trigger=idle) vs " +
      "`auto_capture_compaction_*` (trigger=compaction) carry a `trigger` field, and rows carry the " +
      "auto_capture_compaction tag, so the real-world month-long comparison this simulates a proxy " +
      "for needs no new plumbing.",
  );

  const out = lines.join("\n") + "\n";
  process.stdout.write(out);
  // Same convention as recall-quality.ts: the report lands next to the bench.
  writeFileSync(join(import.meta.dir, "capture-trigger-results.md"), out);
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
process.exitCode = failed ? 1 : 0;
