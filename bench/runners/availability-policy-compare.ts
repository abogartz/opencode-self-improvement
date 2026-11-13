// Availability policy comparison (issue #402, phase P4): does turning the
// availability REFUSAL into a TAG actually win anything, measured on a store
// built only by the shipped capture path?
//
// Five arms over ONE identical capture pass — same fake repo, same scripted
// model reply, same distractors — differing only in what the availability
// verdict does:
//
//   off               no availability check at all
//   tag               #403 as shipped: store the row, tag it `restatable`,
//                     retrieval gives it up first under a byte budget
//   drop-at-read      P3 preview: the row is stored, and a read never shows it.
//                     Applied to the background as well, because a read-time
//                     drop would not know which rows capture wrote
//   delete-hardened   #397 head (`1930bf6`) policy: DROP what #403 tags
//   delete-original   #389's first rule (`362655c`): DROP any row that states
//                     a command the project declares, no residual test
//
// WHAT IS REAL: the shipped plugin end-to-end (test/harness fake model drives the
// actual session.idle listener), the actual 4-gate write pipeline, the actual
// store files, the actual shipped `availabilityIndex` producing every verdict,
// and the actual shipped `selectRelevant` with its real byte budget.
//
// WHAT IS SIMULATED (stated honestly, per epic #68):
//   - the capture MODEL — a scripted faithful extractor naming every fact whose
//     text rode the prompt; control 7 asserts the prompt really carried each one.
//   - the two delete arms. They are DERIVED from the same stored rows by applying
//     the verdict that each policy would have reached, because the delete paths no
//     longer exist in src. This is the strongest form of the comparison, not the
//     weakest: run-to-run variance is exactly zero and every arm sees the same
//     gate decisions. Control 3 pins the `362655c` reproduction to the four
//     candidates it is meant to refuse, so the reproduction cannot drift.
//   - the fake repo. A real git repo in a temp dir, with `README.md`,
//     `package.json` and a `Makefile` tracked. Six documented facts are
//     hand-written prose (they are the TREE, not gold); the ten transport facts
//     and their queries are the committed dataset in bench/fixtures.
//
// MUST GO RED (exit 1) if any control fails — in particular the negative control
// (a header-only budget scores 0 in every arm), the no-drop control (`tag` and
// `off` hold the same rows), the scoring-validity control (a query must be able to
// find its own gold alone in the store, or every recall figure here is meaningless
// and green), the case bank (every adversarial verdict re-decided), and each win
// claim. A harness that cannot fail does not count.
//
//   bun bench/runners/availability-policy-compare.ts
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDir } from "../../src/core/config/paths.ts";
import { dateStr } from "../../src/core/time.ts";
import { RESTATABLE_TAG, USER_GUIDED_TAG } from "../../src/core/tags.ts";
import { formatLine, parseLine } from "../../src/core/logfmt/format.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { type Memory } from "../../src/store/model/memory.ts";
import { isActive } from "../../src/store/model/predicates.ts";
import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { formatMemory } from "../../src/inject/format.ts";
import { availabilityIndex } from "../../src/capture/available.ts";
import { availabilityIndex as historicalAvailabilityIndex } from "../fixtures/available-362655c.ts";
import { selectRelevant } from "../../src/recall/relevant.ts";
import { QUERY_STOPWORDS } from "../../src/recall/score.ts";
import { buildStore, MEMORIES, QUERIES } from "../fixtures/recall-dataset.ts";
import { AVAILABILITY_CASES } from "../fixtures/availability-cases.ts";
import { loadPlugin } from "../../test/harness.ts";

// --- the fake repo ---------------------------------------------------------------

// Six facts the tree STATES. Hand-written, and deliberately topically paired
// with a transport gold below: a query about the gold must also match the doc
// line, or the budget competition this bench measures would not exist.
const DOCUMENTED = [
  "which redis db the rate limiter uses is set in config/limits.ts and reloads on SIGHUP",
  "the healthz readiness probe is wired to the api pod in the kubernetes manifest",
  "logging out revokes the session through the jwt middleware and the cookie store",
  "the csv export endpoint writes a customer data dump to /tmp each night",
  "pg_stat_statements is enabled and its query names are normalised before use",
  "widget_events is the hottest table and takes a schema change most sprints",
];

// Ten facts the tree does NOT state. Eight come straight from the committed
// dataset; four of those state a command the fake repo declares, which is the
// exact population `362655c` deleted.
// A seventh documented fact, deliberately outside the doc queries: it is the
// guided row's text, and a guided row is exempt from the demotion.
const GUIDED_DOC =
  "the deploy task rsyncs dist to the box and restarts the container";
const TRANSPORT_PLAIN = ["m02", "m04", "m07", "m10", "m12", "m14"];
const TRANSPORT_WITH_COMMAND = ["m01", "m05", "m08", "m11"];
const byId = new Map(MEMORIES.map((m) => [m.id, m]));
/** How the shipped extractor writes a command, and how the gate parser finds it. */
const withCommand = (t: string) =>
  t.replace(/\b(make test-api|bun run \w+)\b/, "`$1`");
const TRANSPORT = [...TRANSPORT_PLAIN, ...TRANSPORT_WITH_COMMAND].map(
  (id) => byId.get(id)!,
);

// Declared gates: what the original rule keyed on.
const SCRIPTS = ["codegen", "seed", "migrate", "deploy", "test", "test-api"];

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "README.md"),
    // Each line ends in a period on purpose: `norm()` collapses newlines, so a
    // bullet with no terminal punctuation runs into its neighbour and the
    // polarity guard reads the neighbour's negation as its own.
    `# widget-api\n\n${[...DOCUMENTED, GUIDED_DOC]
      .map((d) => `- ${d}.`)
      .join("\n")}\n`,
  );
  // One transport fact's prose cites `config/limits.ts`, and the write gate
  // refuses a write whose cited path is absent (`ref_path_missing`), so that
  // candidate was silently losing its row and the store held 15 of 16. The file
  // exists here so conservation is exact; the control that names any missing row
  // still fires if a future candidate cites something else.
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(
    join(dir, "config", "limits.ts"),
    "export const QUOTA = 500;\n",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "widget-api",
        scripts: {
          test: "bun test",
          codegen: "graphql-codegen",
          seed: "bun scripts/seed.ts",
          migrate: "bun scripts/migrate.ts",
          deploy: "rsync dist/ box:/srv",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "Makefile"), "test-api:\n\tbun test api\n");
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", dir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0)
      throw new Error(`git ${args.join(" ")}: ${p.stderr?.toString()}`);
  };
  git("init", "-q");
  git("add", ".");
}

// --- the `362655c` baseline ----------------------------------------------------------
//
// Not reproduced by hand. An earlier revision of this runner carried a local
// approximation that looked only for declared commands; the module that actually
// shipped also refuses `in_tracked_file` matches, and against this fixture the
// approximation refused 4 candidates where the real rule refuses 10 (#403 review
// round 2). The arm therefore loads `bench/fixtures/available-362655c.ts`, a pinned
// copy of the historical module, and a control below asserts that copy still
// matches the git object.

// --- run the one capture pass -------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs)
      throw new Error("bench waitFor timed out");
    await sleep(20);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "osi-availability-"));
let failed = false;
try {
  const repo = join(scratch, "widget");
  makeRepo(repo);
  const root = join(scratch, "home");
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  setRepoScope(null);
  resetState();

  // Equal competition, never gold, never captured. Same field every arm sees —
  // the arms differ only in the availability policy, so nothing else may move.
  // 180, not 30: the size sweep below needs a large store to sample from, and a
  // claim measured at ONE competitor count is a claim about that count.
  const goldIds = new Set([...TRANSPORT.map((m) => m.id)]);
  const distractors = buildStore(600)
    .filter(
      (m) =>
        !goldIds.has(m.id.split("#")[0]!) &&
        m.type !== "decision" &&
        m.type !== "preference",
    )
    .slice(0, 180);
  mkdirSync(process.env.OPENCODE_MEMORY_DIR, { recursive: true });
  appendFileSync(
    join(process.env.OPENCODE_MEMORY_DIR, `${dateStr()}.logfmt`),
    distractors
      .map((d, i) =>
        formatLine({
          // One timestamp per row, from its index. An earlier revision wrote
          // `00:00:0${(d.id.length % 9) + 1}`: nine distinct values across 180
          // rows. The verdict map is keyed on `ts`, so most rows were absent
          // from it and every reader of it treated an absent row as restatable.
          // A control below asserts the map is total, which needs these distinct.
          ts: new Date(
            Date.UTC(2026, 0, 1, 0, 0, 0, 1_000 + i * 7),
          ).toISOString(),
          type: d.type,
          scope: d.scope,
          content: d.content,
          status: "settled",
        }),
      )
      .join("\n") + "\n",
  );

  const candidates = [
    ...DOCUMENTED.map((content) => ({
      type: "learning",
      scope: "widget-api",
      content,
    })),
    ...TRANSPORT.map((m) => ({
      type: m.type,
      scope: m.scope,
      content: withCommand(m.content),
    })),
  ];

  const plugin = await loadPlugin(repo, {
    autoCapture: true,
    captureModel: "fake/model",
    captureMax: 30,
  });
  const sid = "ses-availability";
  await plugin["tool.execute.after"](
    { tool: "read", sessionID: sid, callID: "C1", args: { filePath: "x.ts" } },
    { title: "read", output: "content", metadata: {} },
  );
  plugin.capture.context.messages = [
    {
      role: "user",
      content:
        candidates
          .map(
            (c) =>
              `${c.content} That came up while working in ${c.scope}; it mattered for the rest of the session.`,
          )
          .join(" ") +
        " Run the suite and report what changed before you finish.",
    },
  ];
  plugin.capture.generate.response = JSON.stringify(candidates);
  plugin.capture.events.push({
    type: "session.execution.succeeded",
    data: { sessionID: sid },
  });
  const evFile = join(evidenceDir(), `${dateStr()}.logfmt`);
  await waitFor(
    () =>
      existsSync(evFile) &&
      readFileSync(evFile, "utf8").includes(`session=${sid}`),
  );
  await sleep(600);

  const stored = (await loadAll()).filter(
    (m) => isActive(m) && m.tags?.includes("auto-capture"),
  );

  if (process.env.AVAIL_DUMP) {
    const missing = candidates.filter(
      (c) => !stored.some((m) => m.content.includes(c.content.slice(0, 40))),
    );
    console.log(`DUMP stored=${stored.length} missing=${missing.length}`);
    for (const m of missing) console.log(`DUMP MISSING: ${m.content}`);
    const ev = readFileSync(join(evidenceDir(), `${dateStr()}.logfmt`), "utf8");
    for (const l of ev.split("\n"))
      if (/blocked|dup|refus|gate|rejected/i.test(l))
        console.log(`DUMP EV: ${l.slice(0, 240)}`);
  }

  // The seeded background, read back from the store rather than from the fixture
  // builder, so the rows scored are the rows a session would really see. They are
  // identical in every arm: the arms differ only in the availability policy.
  const seeded = (await loadAll()).filter(
    (m) => isActive(m) && !m.tags?.includes("auto-capture"),
  );

  // Verdicts from the SHIPPED check, over every row selection sees — captured rows
  // AND background. Scoring only the captured rows would hide restatable bytes that
  // a real block spends on ordinary memory.
  const idx = availabilityIndex(repo);
  /**
   * The verdict is a pure function of the row's content, so that is what it is
   * keyed on. It used to be keyed on `ts`, and `ts` is NOT unique: the 16 rows
   * this pass writes land in the same millisecond, so the map held one entry for
   * all of them and every lookup returned whichever row happened to be written
   * last. `drop-at-read` then deleted all 16 captured rows because six of them
   * were restatable. A control below pins the count it got wrong.
   */
  const verdictCache = new Map<
    string,
    ReturnType<typeof idx.check> | undefined
  >();
  const verdictOf = (m: Memory): ReturnType<typeof idx.check> => {
    const hit = verdictCache.get(m.content);
    if (hit !== undefined) return hit;
    const v = idx.check(m.content);
    verdictCache.set(m.content, v);
    return v;
  };
  const tagged = stored.filter((m) => m.tags?.includes(RESTATABLE_TAG));
  /** Restatable by the shipped check, independent of what each arm stored. */
  const isRestatable = (m: Memory): boolean => verdictOf(m) !== null;
  /**
   * The same check applied to the rows capture did NOT write. The pass rate on
   * fresh candidates is only interpretable against a base rate: 6 of 16 is 37.5%
   * of a pass, but if the pre-existing store scores a similar rate the check is
   * simply broad, and if it scores near zero the check is singling out what
   * capture produces. Neither reading was available before, and the "0 bytes
   * spent" figures for `drop-at-read` are vacuous either way unless the check
   * fires on something other than this one pass.
   */
  const backgroundRestatable = seeded.filter(isRestatable);
  /**
   * The tracked tree, as text, read back the way the check reads it. Used for two
   * things below: whether a marked row has ANY support in the tree, and whether
   * the seeded background relates to the tree at all — which decides whether the
   * background base rate means anything.
   */
  const treeText = (
    Bun.spawnSync(["git", "-C", repo, "ls-files"]).stdout?.toString() ?? ""
  )
    .split("\n")
    .filter((f) => f.trim())
    .map((f) => readFileSync(join(repo, f), "utf8"))
    .join("\n")
    .toLowerCase();
  const treeTokens = new Set(
    treeText
      .split(/[^a-z0-9']+/)
      .filter((t) => t.length > 3 && !QUERY_STOPWORDS.has(t)),
  );
  /** Every row the check marks, captured or background. */
  const markedAll = [...stored, ...seeded].filter(isRestatable);
  /** Marked rows that share no substantive word with the tree: marked on nothing. */
  const markedWithoutSupport = markedAll.filter((m) => {
    const rowTokens = m.content
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((t) => t.length > 3 && !QUERY_STOPWORDS.has(t));
    return !rowTokens.some((t) => treeTokens.has(t));
  });
  /** Seeded rows that quote a sentence of the tree — the base rate's explanation. */
  const seededSharingTree = seeded.filter((m) => {
    const c = m.content.toLowerCase();
    return treeText
      .split(/[.;:]\s/)
      .some(
        (s) =>
          s.split(/\s+/).filter(Boolean).length >= 6 && c.includes(s.trim()),
      );
  });

  // The historical rule, replayed by the module that shipped it. Cached: the size
  // sweep rebuilds every arm four times and this is a tree scan.
  const hist = historicalAvailabilityIndex(repo);
  // Same content keying as `verdictOf`, for the same reason: `ts` is not unique.
  const histCache = new Map<string, ReturnType<typeof hist.check>>();
  const histOf = (m: Memory): ReturnType<typeof hist.check> => {
    const hit = histCache.get(m.content);
    if (hit !== undefined) return hit;
    const v = hist.check(m.content);
    histCache.set(m.content, v);
    return v;
  };
  const originalKills = stored.filter((m) => histOf(m) !== null);

  // A guided row that is ALSO restatable: the guided lane is exempt from the
  // demotion, so it must still ride a tight budget. Added to every arm, equally.
  const guidedRow = {
    ts: "2026-01-02T00:00:00.000Z",
    type: "context",
    scope: "widget-api",
    content: GUIDED_DOC,
    status: "settled",
    tags: ["auto-capture", USER_GUIDED_TAG, RESTATABLE_TAG],
    original: GUIDED_DOC,
  } as unknown as Memory;

  // Five arms, one background. `drop-at-read` is the P3 preview: the verdict is
  // an EXCLUSION at read time rather than a demotion, so the row stays in the
  // store and stays recallable by anything that reads the store, and simply never
  // competes for a block slot. Whether that is worth building is P5's question,
  // and it is measurable, so it is measured here rather than argued later.
  const names = [
    "off",
    "tag",
    "drop-at-read",
    "delete-hardened",
    "delete-original",
  ] as const;
  function armsWith(background: Memory[]): Record<string, Memory[]> {
    const kept: Record<string, Memory[]> = {
      off: stored.map((m) => ({ ...m, tags: ["auto-capture"] })),
      tag: stored,
      // Applied to the BACKGROUND too: a read-time drop would not know which rows
      // capture wrote, and the seeded rows are restatable by the same check.
      "drop-at-read": stored,
      "delete-hardened": stored.filter(
        (m) => !m.tags?.includes(RESTATABLE_TAG),
      ),
      "delete-original": stored.filter((m) => histOf(m) === null),
    };
    const out: Record<string, Memory[]> = {};
    for (const k of Object.keys(kept))
      out[k] = [...background, ...kept[k]!, guidedRow];
    out["drop-at-read"] = out["drop-at-read"]!.filter(
      (m) => m.ts === guidedRow.ts || !isRestatable(m),
    );
    return out;
  }
  const arms = armsWith(seeded);

  // --- scoring ---------------------------------------------------------------------
  //
  // One question per column, and a SWEEP of budgets rather than one number I
  // picked. A policy can only differ where the budget binds, so choosing a single
  // budget chooses the answer: too loose and every arm fits everything, too tight
  // and no arm fits anything. The claim below is "at least as good at every
  // budget", which is falsifiable at each one.
  const transportQueries = QUERIES.filter((q) =>
    TRANSPORT.some((m) => m.id === q.gold),
  );
  // Hand-written, one per documented fact. These measure the COST side: what a
  // demoted row gives up when its own topic is asked about.
  const documentedQueries = DOCUMENTED.map((d) => ({
    q: `what does the widget-api doc say about ${d.split(" ").slice(2, 6).join(" ")}`,
    content: d,
  }));

  // ── What can this harness score at all? ───────────────────────────────────
  // The negative direction of the hit metric is pinned by the header-only budget:
  // a hit can be missed. Nothing pinned that one can be FOUND, and the gap is not
  // hypothetical — 12 of the 21 transport queries score 0 against their own gold
  // ALONE in an empty store.
  //
  // Two ceilings, because review round 4 (WhollyMindless) showed they are not the
  // same number. The ceiling that matters for every figure in this report is
  // measured on the EXACT rows the arms retrieve: the captured rows, which carry no
  // keywords at all (the scripted capture reply emits none, counted below). The
  // other ceiling adds the dataset's authored `kw`, and adding it turns 5 of the 12
  // blind queries around — so a ceiling taken from kw-bearing rows is not the
  // ceiling of these arms, and "9/14" would mix a numerator from one representation
  // with a ceiling from another.
  const storeRows = new Map(buildStore(600).map((s) => [s.id, s]));
  const capturedWithKw = stored.filter((m) => (m.kw?.length ?? 0) > 0).length;
  /** The gold as the ARMS hold it: the captured row, nothing added. */
  const exactRowFor = (goldId: string): Memory | undefined => {
    const gold = withCommand(byId.get(goldId)!.content);
    return stored.find((m) => m.content.includes(gold.slice(0, 60)));
  };
  const solo = (
    content: string,
    i: number,
    kwId?: string,
    extra?: Partial<Memory>,
  ): Memory =>
    ({
      ts: `2026-01-03T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      type: "learning",
      scope: "widget-api",
      content,
      status: "settled",
      ...(kwId ? { kw: storeRows.get(kwId)?.kw } : {}),
      ...extra,
    }) as unknown as Memory;

  /** Queries whose gold is never retrieved, given a row-builder. */
  async function blindAgainst(
    build: (
      q: (typeof transportQueries)[number],
      i: number,
    ) => Memory | undefined,
    probe: (q: (typeof transportQueries)[number], row: Memory) => string,
  ): Promise<string[]> {
    const blind: string[] = [];
    for (const [i, q] of transportQueries.entries()) {
      const row = build(q, i);
      if (!row) {
        blind.push(`${q.gold}?`);
        continue;
      }
      const { block } = await selectRelevant(
        q.q,
        30,
        [row],
        undefined,
        undefined,
        { budget: 100_000, guidedCap: 3 },
      );
      if (!block.includes(probe(q, row))) blind.push(q.gold);
    }
    return blind;
  }

  const goldOf = (q: (typeof transportQueries)[number]) =>
    withCommand(byId.get(q.gold)!.content);
  const blindExact = await blindAgainst(
    (q, i) => {
      const row = exactRowFor(q.gold);
      return (
        row &&
        ({
          ...row,
          ts: `2026-01-03T11:00:${String(i % 60).padStart(2, "0")}.000Z`,
        } as Memory)
      );
    },
    (q) => goldOf(q).slice(0, 60),
  );
  const blindAuthoredKw = await blindAgainst(
    (q, i) => solo(goldOf(q), i, q.gold),
    (q) => goldOf(q).slice(0, 60),
  );
  const blindDoc: string[] = [];
  for (const [i, q] of documentedQueries.entries()) {
    const { block } = await selectRelevant(
      q.q,
      30,
      [solo(q.content, i)],
      undefined,
      undefined,
      { budget: 100_000, guidedCap: 3 },
    );
    if (!block.includes(q.content.slice(0, 60)))
      blindDoc.push(q.content.slice(0, 34));
  }
  const ceilingT = transportQueries.length - blindExact.length;
  const ceilingKw = transportQueries.length - blindAuthoredKw.length;
  const ceilingD = documentedQueries.length - blindDoc.length;

  const unlimited = await selectRelevant(
    transportQueries[0]!.q,
    30,
    arms.tag,
    undefined,
    undefined,
    { budget: 100_000, guidedCap: 3 },
  );
  const FULL = unlimited.block.length;
  const FRACS = [0.15, 0.25, 0.4, 0.6, 0.85];

  interface Cell {
    transportHits: number;
    docHits: number;
    restatableBytes: number;
    guidedRides: number;
  }
  async function scoreAt(rows: Memory[], budget: number): Promise<Cell> {
    const c: Cell = {
      transportHits: 0,
      docHits: 0,
      restatableBytes: 0,
      guidedRides: 0,
    };
    for (const q of transportQueries) {
      const { block } = await selectRelevant(
        q.q,
        30,
        rows,
        undefined,
        undefined,
        { budget, guidedCap: 3 },
      );
      const gold = withCommand(byId.get(q.gold)!.content);
      if (block.includes(gold.slice(0, 60))) c.transportHits++;
      // Counted by the SHIPPED verdict, not by each arm's own tags: the no-check
      // arm carries no tags, so counting tags would score it as spending nothing
      // on facts the tree states, which is the opposite of what it does.
      for (const m of rows) {
        if (m.ts === guidedRow.ts) continue;
        if (verdictOf(m) === null) continue;
        const line = formatMemory(m);
        if (block.includes(line)) c.restatableBytes += line.length;
      }
      if (block.includes(formatMemory(guidedRow))) c.guidedRides++;
      if (process.env.AVAIL_DUMP && budget === Math.round(FULL * 0.4))
        console.log(`DUMP ${q.q.slice(0, 34)}\n${block}\n`);
    }
    // Per BLOCK, not summed over queries. The column is labelled "bytes per
    // block"; summing across every query produced a number that looked like a
    // block size and was really twenty-one of them, which made the byte claim
    // unreadable even while it stayed monotone across arms.
    c.restatableBytes = Math.round(c.restatableBytes / transportQueries.length);
    for (const q of documentedQueries) {
      const { block } = await selectRelevant(
        q.q,
        30,
        rows,
        undefined,
        undefined,
        { budget, guidedCap: 3 },
      );
      if (block.includes(q.content.slice(0, 60))) c.docHits++;
    }
    return c;
  }

  const grid = new Map<string, Map<number, Cell>>();
  for (const n of names) {
    const row = new Map<number, Cell>();
    for (const f of FRACS)
      row.set(f, await scoreAt(arms[n]!, Math.round(FULL * f)));
    grid.set(n, row);
  }
  const cell = (n: string, f: number) => grid.get(n)!.get(f)!;
  const col = (n: string, k: keyof Cell) =>
    FRACS.map((f) => cell(n, f)[k]).join(",");

  // What a policy leaves in the store is a separate fact from what one budget
  // shows. A deleted row is unreachable at EVERY budget: that is the whole cost
  // side of the delete arms, and it is invisible in any single-budget column.
  const restatableStored = (rows: Memory[]) =>
    rows.filter((m) => m.ts !== guidedRow.ts && verdictOf(m) !== null).length;
  /** The same count restricted to rows THIS pass captured. */
  const capturedTs = new Set(stored.map((m) => m.ts));
  /**
   * Everything in an arm that this pass did NOT capture, in a stable order. Equal
   * across arms by construction, so any difference is a filter bug.
   */
  const nonCaptured = (rows: Memory[]) =>
    rows
      .filter((m) => !capturedTs.has(m.ts))
      .map((m) => m.ts)
      .sort();
  const expectedNonCaptured = [...seeded.map((m) => m.ts), guidedRow.ts].sort();
  const restatableCaptured = (rows: Memory[]) =>
    rows.filter(
      (m) =>
        capturedTs.has(m.ts) && m.ts !== guidedRow.ts && verdictOf(m) !== null,
    ).length;
  const transportStored = (rows: Memory[]) =>
    TRANSPORT.filter((g) =>
      rows.some((m) => m.content.includes(withCommand(g.content).slice(0, 60))),
    ).length;

  const lines: string[] = [];
  lines.push("# Availability: tag vs delete — measured on one capture pass");
  lines.push("");
  lines.push(
    `${stored.length} rows written by the shipped capture path over ${candidates.length} scripted ` +
      `candidates, ${seeded.length} seeded background rows in EVERY arm, ${transportQueries.length} ` +
      `dataset queries +${documentedQueries.length} doc queries. Verdicts from the shipped ` +
      `availabilityIndex over captured and background rows alike; selection by the shipped ` +
      `selectRelevant with its real byte budget. ` +
      "`delete-original` replays the pinned `362655c` module, not an approximation of it. " +
      `Budgets are fractions of the unbudgeted block (${FULL} bytes).`,
  );
  lines.push("");
  lines.push("## What each policy leaves in the store");
  lines.push("");
  lines.push(
    "| arm | rows | transport facts kept | restatable facts kept | model calls |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const n of names) {
    const rows = arms[n]!;
    lines.push(
      `| ${n} | ${rows.length} | ${transportStored(rows)}/${TRANSPORT.length} | ` +
        `${restatableStored(rows)}/${restatableStored(arms.tag!)} | ` +
        `${plugin.capture.generate.calls.length} |`,
    );
  }
  lines.push("");
  lines.push("## What each budget shows");
  lines.push("");
  lines.push(
    "| budget | transport facts in block | restatable bytes per block (mean) | doc facts in block |",
  );
  lines.push("| ---: | ---: | ---: | ---: |");
  for (const f of FRACS) {
    const t = names.map((n) => cell(n, f).transportHits).join(" / ");
    const b = names.map((n) => cell(n, f).restatableBytes).join(" / ");
    const d = names.map((n) => cell(n, f).docHits).join(" / ");
    lines.push(
      `| ${Math.round(FULL * f)} (${Math.round(f * 100)}%) | ${t} | ${b} | ${d} |`,
    );
  }
  lines.push("");
  lines.push(
    `Arms in every column: ${names.join(" / ")}. The guided row is exempt from the demotion by ` +
      `design and rode ${cell("tag", FRACS[FRACS.length - 1]!).guidedRides}/${transportQueries.length} ` +
      `blocks at the loosest budget; the exemption control below measures it from the first budget ` +
      `that can physically hold the line, because at 15% the header plus the guided row exceeds the ` +
      `budget in every arm and that is arithmetic, not policy.`,
  );
  lines.push("");
  lines.push(
    `**Ceiling.** ${ceilingT} of ${transportQueries.length} transport queries retrieve their own gold ` +
      `when that gold is the ONLY row in the store, measured on the exact captured rows the arms ` +
      `retrieve; ${ceilingD} of ${documentedQueries.length} doc queries do. Every recall figure above is ` +
      `out of those, not out of ${transportQueries.length} — the best arm reaches ` +
      `${Math.max(...names.map((n) => cell(n, FRACS[FRACS.length - 1]!).transportHits))}/${ceilingT}, ` +
      `which is ${Math.max(...names.map((n) => cell(n, FRACS[FRACS.length - 1]!).transportHits)) === ceilingT ? "at the achievable ceiling" : "below it"}. ` +
      `A SECOND ceiling is reported because the two are not the same number: give the same golds the ` +
      `dataset's authored keywords and ${ceilingKw}/${transportQueries.length} retrieve, because ` +
      `${ceilingKw - ceilingT} of the ${blindExact.length} blind queries turn retrievable on keywords ` +
      `alone. The captured rows carry none (${capturedWithKw} of ${stored.length}), because the scripted ` +
      `capture reply emits none — a property of this fixture, stated rather than assumed. ` +
      `${[...new Set(blindExact)].join(", ")} are unretrievable on the rows the arms hold, and ` +
      `${[...new Set(blindAuthoredKw)].join(", ")} of them stay unretrievable even with authored ` +
      `keywords — those are the scorer/dataset finding (#405), reported here and not this bench's to fix.`,
  );
  lines.push("");
  // The cost, stated by the harness rather than left for the reader to find in
  // the table. A demoted row that is the best answer to its own question loses
  // that slot to a better match — the tree states the fact, so the demotion is
  // correct, and the loss is still real and belongs in the same report.
  const paid = FRACS.filter(
    (f) => cell("tag", f).docHits < cell("off", f).docHits,
  );
  lines.push("");
  lines.push(
    paid.length === 0
      ? "No doc-query cost observed at any budget."
      : `**Cost.** The tag arm answers ${col("tag", "docHits")} of ` +
          `${documentedQueries.length} queries about facts the README also states, where the no-check arm ` +
          `answers ${col("off", "docHits")}. It gives up those slots at ` +
          `${paid.map((f) => `${Math.round(f * 100)}%`).join(", ")} budget — the demotion working as ` +
          `designed, because the tree has the fact, and a real loss all the same. At 85% the budget ` +
          `holds everything and the two arms agree.`,
  );
  lines.push("");
  // The base rate, stated with its cause. "0 of 180" without the cause reads as
  // the check being sparing on ordinary rows; here the fixture simply gives it
  // nothing to find. The prose is conditional because the sentence must not be
  // able to outlive the number that makes it true.
  lines.push(
    `**Where the tag lands.** ${tagged.length} of ${stored.length} rows this pass wrote carry it ` +
      `(${Math.round((tagged.length / stored.length) * 100)}%), against ${backgroundRestatable.length} ` +
      `of ${seeded.length} rows already in the store when the pass ran ` +
      `(${Math.round((backgroundRestatable.length / seeded.length) * 100)}%). ` +
      (backgroundRestatable.length === 0
        ? `That 0 is a property of this fixture, not of the check: ${seededSharingTree.length} of the ` +
          `${seeded.length} seeded rows quote a sentence of the tracked tree, so there was nothing there ` +
          `for the check to find. No real-world base rate is claimed — that needs a store written in the ` +
          `same repo it is read from.`
        : `${seededSharingTree.length} of those marked background rows quote a sentence of the tracked ` +
          `tree; read the base rate against that, not as a rate over unrelated prose.`) +
      ` What is established is the direction the tag asserts: all ${markedAll.length} marked rows share ` +
      `substantive words with the tracked tree, which the control below re-checks every run.`,
  );
  lines.push("");

  // ── Does the win survive a different store size? ────────────────────────────
  // One competitor count is one data point. The demotion only pays where the
  // budget binds, and how hard it binds depends on how many ordinary rows are
  // competing, so a claim measured at a single store size is a claim about that
  // size. The budget is recomputed per size from that size's own unbudgeted
  // block, or the sweep would silently test a tighter budget as the store grew.
  const SIZES = [0, 30, 90, 180].filter((s) => s <= seeded.length);
  const sweepFracs = [0.25, 0.4, 0.6];
  interface SweepRow {
    size: number;
    full: number;
    hits: Record<string, number[]>;
  }
  const sweep: SweepRow[] = [];
  for (const size of SIZES) {
    const a = armsWith(seeded.slice(0, size));
    const unlimited = await selectRelevant(
      transportQueries[0]!.q,
      30,
      a.tag!,
      undefined,
      undefined,
      { budget: 100_000, guidedCap: 3 },
    );
    const full = unlimited.block.length;
    const hits: Record<string, number[]> = {};
    for (const n of names) {
      const seen: number[] = [];
      for (const f of sweepFracs)
        seen.push((await scoreAt(a[n]!, Math.round(full * f))).transportHits);
      hits[n] = seen;
    }
    sweep.push({ size, full, hits });
  }
  lines.push("## Does the win survive a different store size?");
  lines.push("");
  lines.push(
    `Same ${candidates.length} captured rows, background resampled at ${SIZES.join("/")} rows; ` +
      `budget recomputed per size (${sweep.map((s) => s.full).join("/")} bytes unbudgeted), ` +
      `shown at ${sweepFracs.map((f) => `${Math.round(f * 100)}%`).join(", ")}. ` +
      "Transport facts in block.",
  );
  lines.push("");
  lines.push(`| background | ${names.join(" | ")} |`);
  lines.push(`| ---: | ${names.map(() => "---:").join(" | ")} |`);
  for (const s of sweep) {
    lines.push(
      `| ${s.size} | ${names.map((n) => s.hits[n]!.join("/")).join(" | ")} |`,
    );
  }
  lines.push("");

  // ── The case bank (P4) ──────────────────────────────────────────────────────
  // Every adversarial case this matcher has been found guilty of, re-decided by
  // the shipped check on every run. The unit tests pin behaviour one case at a
  // time; this says whether the POPULATION of verdicts moved, because a single
  // flipped verdict changes the tag rate and therefore every number above.
  const bank = await runCaseBank(scratch);
  const bankBad = bank.filter((b) => b.got !== b.expectTag);
  const bankWrongBranch = bank.filter(
    (b) => b.expectReason && b.reason !== b.expectReason,
  );
  const gateVerdicts = bank.filter((b) => b.reason === "declared_gate").length;
  const textVerdicts = bank.filter(
    (b) => b.reason === "in_tracked_file",
  ).length;
  lines.push("## Case bank: every adversarial verdict, re-decided");
  lines.push("");
  lines.push(
    `${bank.length} (tree, candidate) pairs, one repo each, decided by the shipped ` +
      `availabilityIndex. ${bank.filter((b) => b.expectTag).length} must tag, ` +
      `${bank.filter((b) => !b.expectTag).length} must not.`,
  );
  lines.push("");
  lines.push("| case | expect | got | found by |");
  lines.push("| --- | --- | --- | --- |");
  for (const b of bank) {
    lines.push(
      `| ${b.id} | ${b.expectTag ? "tag" : "keep"} | ${b.got ? (b.reason ?? "tag") : "keep"}${b.got === b.expectTag ? "" : " **MISMATCH**"} | ${b.source} |`,
    );
  }
  lines.push("");

  const controls: string[] = [];
  const check = (ok: boolean, label: string) => {
    controls.push(`${ok ? "PASS" : "FAIL"} — ${label}`);
    if (!ok) failed = true;
  };
  const tight = FRACS[FRACS.length - 2]!;

  // The competition the report advertises must be inside the selector, not just on
  // disk. An earlier revision filtered the background rows out on the `auto-capture`
  // tag and still printed their count (#403 review round 2), which is the failure
  // mode this whole file exists to catch: a harness measuring something else.
  check(
    seeded.length > 0 &&
      names
        .filter((n) => n !== "drop-at-read")
        .every(
          (n) =>
            JSON.stringify(nonCaptured(arms[n]!)) ===
            JSON.stringify(expectedNonCaptured),
        ),
    `the background really competes: the ${seeded.length} seeded rows plus the guided control are the identical set in every storage arm (sizes ${names.map((n) => arms[n]!.length).join("/")} — drop-at-read is smaller on purpose, it filters at read time) — RED if a filter drops them again`,
  );
  // The historical baseline is only faithful while the vendored copy is the
  // historical module. Checked against the object, not against a remembered count.
  const pinned = Bun.spawnSync(
    [
      "git",
      "-C",
      join(import.meta.dir, "..", ".."),
      "show",
      "362655c:src/capture/available.ts",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const vendored = readFileSync(
    join(import.meta.dir, "..", "fixtures", "available-362655c.ts"),
    "utf8",
  );
  check(
    pinned.exitCode !== 0 ||
      vendored.includes(pinned.stdout.toString().trimStart().slice(0, 400)),
    `the pinned baseline is the real module${pinned.exitCode !== 0 ? " (git object unavailable here; the vendored copy is what ran)" : ""} — RED if the fixture was edited away from 362655c`,
  );

  const headerOnly = await scoreArmHeaderOnly(arms.tag);
  check(
    headerOnly === 0,
    `negative control: a header-only budget puts 0 facts in the block (got ${headerOnly}) — a harness that cannot fail does not count`,
  );
  check(
    arms.tag!.length === arms.off!.length &&
      new Set(arms.tag!.map((m) => m.content)).size ===
        new Set(arms.off!.map((m) => m.content)).size,
    `no drop: the tag arm holds every row the no-check arm holds (${arms.tag!.length}), of which ${tagged.length} carry the tag — RED if any path in available.ts prevents a write`,
  );
  // Pins the MEANING of the two scan fields, which a review round got wrong.
  // `verdicts` counts candidates the availability check matched; `restatements`
  // counts rows that really carry the tag. The verdict fires before the write
  // gate, so a candidate the gate refuses (a dup, a credential-shaped scope) has a
  // verdict and no row: `verdicts >= restatements`, and only `restatements` is a
  // fact about the store. This fixture lands one verdict on a refused candidate,
  // so it exercises the gap rather than assuming it away.
  const scanLine = readFileSync(
    join(evidenceDir(), `${dateStr()}.logfmt`),
    "utf8",
  )
    .split("\n")
    .filter(
      (l) => l.includes("ev=auto_capture_scan") && l.includes(`session=${sid}`),
    )
    .map((l) => parseLine(l))
    .filter((v) => v !== undefined);
  const scan = scanLine[0] ?? {};
  check(
    scanLine.length === 1 &&
      Number(scan.restatements) === tagged.length &&
      Number(scan.verdicts) >= tagged.length,
    `the scan line separates its two numbers: verdicts=${scan.verdicts} (candidates the check matched) vs restatements=${scan.restatements} (rows that carry the tag) — RED if a verdict the write gate refused is reported as a tagged row, or if either field drifts`,
  );
  // Whether THIS fixture happens to contain a refused candidate is a property of
  // the fixture, not a claim about the code, so it is reported and not asserted.
  // The case itself is pinned in test/capture-available.test.ts.
  lines.push("");
  lines.push(
    `The scan line reported ${scan.verdicts} verdicts and ${scan.restatements} tagged rows; ` +
      `${Number(scan.verdicts) - Number(scan.restatements)} of those verdicts landed on a candidate ` +
      `the write gate refused. The two fields are kept apart because a single number invites reading ` +
      `a verdict as a stored row.`,
  );
  lines.push("");
  // Conservation, named. The capture path is allowed to lose a row only to a
  // gate decision the report can show; a row that vanishes with no explanation
  // makes every number above meaningless, because the arms are scored over rows
  // that exist.
  const missing = candidates.filter(
    (c) => !stored.some((m) => m.content.includes(c.content.slice(0, 40))),
  );
  check(
    missing.length === 0,
    `conservation: all ${candidates.length} scripted candidates reached the store${missing.length ? ` — LOST: ${missing.map((m) => m.content.slice(0, 48)).join(" | ")}` : ""}, RED with the lost prose named so the gate reason can be read off the trail`,
  );
  check(
    originalKills.length >= TRANSPORT_WITH_COMMAND.length &&
      DOCUMENTED.every((d) =>
        stored.some(
          (m) =>
            m.content.includes(d.slice(0, 40)) &&
            hist.check(m.content) !== null,
        ),
      ),
    `the baseline is the historical rule, not a stand-in: the pinned 362655c module refuses ${originalKills.length} of ${stored.length} captured rows, including every documented fact and all ${TRANSPORT_WITH_COMMAND.length} command-stating ones — RED if the vendored module drifts or a hand-written approximation creeps back`,
  );
  check(
    transportStored(arms["delete-original"]!) < TRANSPORT.length,
    `the bench can measure a loss: delete-original keeps ${transportStored(arms["delete-original"]!)}/${TRANSPORT.length} transport facts, the rest deleted before the write`,
  );
  const neverBehind = FRACS.every(
    (f) =>
      cell("tag", f).transportHits >= cell("delete-original", f).transportHits,
  );
  check(
    neverBehind &&
      cell("tag", tight).transportHits >
        cell("delete-original", tight).transportHits,
    `WIN vs the original rule: tag delivers ${cell("tag", tight).transportHits}/${ceilingT} retrievable transport facts (${transportQueries.length} asked) at the binding budget, delete-original ${cell("delete-original", tight).transportHits}, and tag is never behind at any budget (${col("tag", "transportHits")} vs ${col("delete-original", "transportHits")}) — a deleted fact cannot be retrieved`,
  );
  check(
    FRACS.every(
      (f) => cell("tag", f).transportHits >= cell("off", f).transportHits,
    ),
    `the demotion costs no recall: tag is at or above the no-check arm on transport facts at all ${FRACS.length} budgets (${col("tag", "transportHits")} vs ${col("off", "transportHits")})`,
  );
  // The honest shape of the byte claim. It is NOT "always fewer": at 15% nothing
  // fits in either arm, at 85% everything does, and in between a restatable row
  // that is the best match for its own query still rides, because the demotion is
  // a walk order and not an exclusion. What it does claim, and what would be a
  // bug if it broke, is never-worse and better-somewhere.
  check(
    FRACS.every(
      (f) => cell("tag", f).restatableBytes <= cell("off", f).restatableBytes,
    ) &&
      FRACS.some(
        (f) => cell("tag", f).restatableBytes < cell("off", f).restatableBytes,
      ),
    `WIN vs no check at all, stated honestly: the tag arm never spends MORE block bytes on facts the tree already states, at any budget, and spends fewer where the budget binds (${col("tag", "restatableBytes")} vs ${col("off", "restatableBytes")})`,
  );
  check(
    restatableCaptured(arms["delete-hardened"]!) === 0 &&
      restatableCaptured(arms.tag!) > 0,
    `deleting is not free: the tag arm keeps ${restatableCaptured(arms.tag!)} captured restatable facts a budget can still surface; #397's policy keeps ${restatableCaptured(arms["delete-hardened"]!)}, unreachable at any budget`,
  );
  // The exemption can only be observed where the budget can physically hold the
  // line: at 15% the header plus the guided line exceeds the budget in EVERY arm,
  // which is arithmetic, not policy. Measured from 25% up.
  const fits = FRACS.filter((f) => Math.round(FULL * f) > 400);
  check(
    names.every((n) =>
      fits.every((f) => cell(n, f).guidedRides === transportQueries.length),
    ),
    `the guided lane is exempt: a guided AND restatable row still rides ${cell("tag", fits[0]!).guidedRides}/${transportQueries.length} blocks at every budget that can hold it (${fits.map((f) => Math.round(FULL * f)).join(", ")} bytes)`,
  );
  check(
    plugin.capture.generate.calls.length === 1,
    "one model call per pass whatever the policy — availability is decided after the call, so #389 AC4 cannot lower capture cost",
  );
  check(
    candidates.every((c) =>
      plugin.capture.generate.calls[0]!.prompt.includes(c.content),
    ),
    "prompt containment: every scripted fact really rode the capture prompt",
  );

  // ── Controls for what this revision added ───────────────────────────────────
  // The bank must be able to say BOTH things. A bank of only "must tag" cases
  // passes on a check that tags everything; one of only "must not" passes on a
  // check that tags nothing. Both polarities present is what makes the count
  // mean anything at all.
  check(
    bank.length >= 12 &&
      bank.filter((b) => b.expectTag).length >= 3 &&
      bank.filter((b) => !b.expectTag).length >= 6,
    `the case bank can say both things: ${bank.length} cases, ${bank.filter((b) => b.expectTag).length} must tag and ${bank.filter((b) => !b.expectTag).length} must not — RED if either polarity is emptied out`,
  );
  check(
    bankBad.length === 0,
    `the shipped matcher still decides every adversarial case: ${bank.length - bankBad.length}/${bank.length}${bankBad.length ? ` — DRIFTED: ${bankBad.map((b) => `${b.id} expected ${b.expectTag ? "tag" : "keep"}, got ${b.got ? "tag" : "keep"}`).join(" | ")}` : ""} — RED with the case named, so the veto that moved is readable from its "found by" column`,
  );
  // Review round 4: seven cases named for the declared-command branch were
  // decided by README prose, so the branch could be deleted and the bank stayed
  // green. Two halves: a case that says which branch must answer is checked
  // against that branch, and the branch must be present in the population at all.
  check(
    bankWrongBranch.length === 0,
    `every case that names a branch gets that branch: ${bank.filter((b) => b.expectReason).length} branch-pinned cases, ${bankWrongBranch.length} answered by the other half${bankWrongBranch.length ? ` — ${bankWrongBranch.map((b) => `${b.id} expected ${b.expectReason}, got ${b.reason || "none"}`).join(" | ")}` : ""} — RED with the case named, because a gate case answered by prose tests nothing of the gate`,
  );
  check(
    gateVerdicts >= 2 && textVerdicts >= 2,
    `the bank reaches both branches of the check: ${gateVerdicts} declared_gate and ${textVerdicts} in_tracked_file verdicts — RED if either drops below 2, which is how a branch disappears while every verdict still looks right`,
  );
  // The defect this control was written for, found by writing it: `ts` is not
  // unique — the 16 rows one pass writes land in the same millisecond — so the
  // verdict map keyed on it handed every lookup the same answer, and
  // `drop-at-read` deleted all 16 captured rows because six of them were
  // restatable. Transport golds are NOT restatable, which is the entire premise
  // of the tag policy, so an arm that drops them is scoring a bug, not a policy.
  check(
    transportStored(arms["drop-at-read"]!) === TRANSPORT.length &&
      arms["drop-at-read"]!.length ===
        arms.tag!.length -
          [...arms.tag!].filter((m) => m.ts !== guidedRow.ts && isRestatable(m))
            .length,
    `a read-time drop removes exactly the restatable rows and nothing else: it keeps ${transportStored(arms["drop-at-read"]!)}/${TRANSPORT.length} transport facts and ${arms["drop-at-read"]!.length} of ${arms.tag!.length} rows — RED if a verdict is read from the wrong row, which is what a ts-keyed lookup does when a pass writes rows in one millisecond`,
  );
  check(
    ceilingT > 0 && ceilingD > 0,
    `the hit metric can score at all: ${ceilingT}/${transportQueries.length} transport (exact captured rows) and ${ceilingD}/${documentedQueries.length} doc queries retrieve their own gold alone${blindExact.length ? ` — unretrievable golds: ${[...new Set(blindExact)].join(", ")}` : ""} — RED if a family goes wholly blind, because a wholly blind family reports 0 in every arm and no other control would notice`,
  );
  // The tag's own claim, tested instead of asserted: a row is marked because the
  // tracked tree states the fact. A marked row with no substantive word in common
  // with the tree is a row marked on nothing, and every byte figure in this report
  // would then rest on a check that fires at random. `markedAll.length > 0` is the
  // other half — with nothing marked the first clause is vacuously true, and a
  // vacuous pass is how a check that stopped working reads as green.
  check(
    markedAll.length > 0 && markedWithoutSupport.length === 0,
    `every marked row is supported by the tracked tree: ${markedAll.length} marked of ${stored.length + seeded.length} rows, ${markedWithoutSupport.length} with no substantive word in common${markedWithoutSupport.length ? ` — ${markedWithoutSupport.map((m) => m.content.slice(0, 40)).join(" | ")}` : ""} — RED if a row is marked on nothing, or if nothing is marked at all`,
  );
  check(
    sweep.every((s) =>
      sweepFracs.every(
        (_, i) =>
          s.hits.tag![i]! >= s.hits["delete-original"]![i]! &&
          s.hits.tag![i]! >= s.hits["drop-at-read"]![i]!,
      ),
    ),
    `the win is not an artefact of one store size: tag is at or above both delete-original and drop-at-read on transport facts at all ${SIZES.length} background sizes x ${sweepFracs.length} budgets (${sweep.map((s) => `${s.size}:${s.hits.tag!.join("/")}`).join(" ")})`,
  );
  check(
    FRACS.every((f) => cell("drop-at-read", f).restatableBytes === 0),
    `the P3 preview does what it claims: drop-at-read spends 0 block bytes on facts the tree states at every budget — and the transport column is the price (${col("drop-at-read", "transportHits")} vs tag ${col("tag", "transportHits")})`,
  );

  // ── Is the verdict a property of the tree, or of the row? ───────────────────
  // The tag's entire justification is that the TRACKED TREE states the fact. That
  // is testable: empty the tree's text and no row can still be restatable. It is
  // also the one axis where a read-time policy beats deleting a row outright — when
  // the tracked sentence goes away the row is retrievable again, and a deleted row
  // never comes back. Measured on a COPY of the repo, so every arm above keeps the
  // tree it was measured against.
  const stillMarkedWith = (name: string, stripManifests: boolean): number => {
    const dir = join(scratch, `emptied-${name}`);
    cpSync(repo, dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# widget\n");
    if (stripManifests) {
      writeFileSync(join(dir, "package.json"), '{ "name": "widget" }\n');
      writeFileSync(join(dir, "Makefile"), "# no targets\n");
    }
    const probe = availabilityIndex(dir);
    return markedAll.filter((m) => probe.check(m.content) !== null).length;
  };
  const markedProseGone = stillMarkedWith("prose", false);
  const markedAllGone = stillMarkedWith("all", true);
  lines.push("");
  lines.push("## Is the verdict a property of the tree, or of the row?");
  lines.push("");
  lines.push(
    `The tag claims the tracked tree already states the fact, so emptying the tree must un-mark every ` +
      `row. Copied repo, emptied text, same rows, shipped check:`,
  );
  lines.push("");
  lines.push("| tree state | rows still marked |");
  lines.push("| --- | ---: |");
  lines.push(`| as shipped | ${markedAll.length} |`);
  lines.push(`| README prose emptied, manifests intact | ${markedProseGone} |`);
  lines.push(`| prose and declared commands both emptied | ${markedAllGone} |`);
  lines.push("");
  lines.push(
    `${markedAll.length - markedProseGone} of ${markedAll.length} verdicts came from the prose and ` +
      `disappear with it. The difference this exposes belongs to P3 rather than to this change: a ` +
      `read-time drop re-asks the question on every read, so a row whose tracked sentence has since been ` +
      `deleted becomes retrievable on its own again. A deleted row has no such moment — the tag arm holds ` +
      `${arms.tag!.length} rows, the hardened arm ${arms["delete-hardened"]!.length} and the original ` +
      `${arms["delete-original"]!.length}, and the ${arms.tag!.length - arms["delete-hardened"]!.length} ` +
      `and ${arms.tag!.length - arms["delete-original"]!.length} rows those arms never wrote stay unwritten ` +
      `whatever the tree later says.`,
  );
  lines.push("");

  // The claim, tested: the verdict follows the tree. If any row stayed marked with
  // nothing left in the tree to state it, the tag would be justified by something in
  // the row alone, and every byte figure in this report would rest on a check that
  // reads the candidate and not the repository.
  check(
    markedAllGone === 0 && markedProseGone <= markedAll.length,
    `the verdict follows the tree, not the row: ${markedAll.length} rows marked against the shipped tree, ${markedProseGone} still marked with the README prose emptied, ${markedAllGone} with the tree emptied entirely — RED if anything survives an empty tree, because then the tag is justified by something the tree has nothing to do with`,
  );

  lines.push("## Controls");
  lines.push("");
  for (const c of controls) lines.push(`- ${c}`);
  lines.push("");
  lines.push(
    `Scan cost for these ${candidates.length} candidates: ${idx.scanned().files} files, ` +
      `${idx.scanned().bytes} bytes, capped=${idx.scanned().capped}. A pass with no candidates ` +
      `builds the index never (test/capture-available.test.ts pins it).`,
  );
  lines.push("");
  lines.push(
    "Reproduce: `bun bench/runners/availability-policy-compare.ts`. Set `AVAIL_DUMP=1` to print " +
      "the block for the first queries of each arm.",
  );

  const out = lines.join("\n") + "\n";
  process.stdout.write(out);
  writeFileSync(join(import.meta.dir, "..", "availability-results.md"), out);
} finally {
  rmSync(scratch, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  });
}

/**
 * Re-decide the case bank. One repo per case: sharing a tree would let a
 * candidate match a DIFFERENT case's line and report a verdict for the wrong
 * reason, which is the class of defect this file exists to keep out.
 */
async function runCaseBank(parent: string): Promise<
  Array<{
    id: string;
    expectTag: boolean;
    got: boolean;
    reason: string;
    expectReason: string;
    source: string;
  }>
> {
  const root = mkdtempSync(join(parent, "bank-"));
  const out: Array<{
    id: string;
    expectTag: boolean;
    got: boolean;
    reason: string;
    expectReason: string;
    source: string;
  }> = [];
  for (const c of AVAILABILITY_CASES) {
    const dir = join(root, c.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), c.tree);
    // A case named for the declared-command branch has to DECLARE the command in
    // a file `parseGates` reads. Writing only README.md — which is what this did —
    // means the text branch answers for it and the gate is untested.
    for (const [path, content] of Object.entries(c.files ?? {})) {
      const target = join(dir, path);
      mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      writeFileSync(target, content);
    }
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(["git", "-C", dir, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (p.exitCode !== 0)
        throw new Error(`git ${args.join(" ")}: ${p.stderr?.toString()}`);
    };
    git("init", "-q");
    git("add", ".");
    const v = availabilityIndex(dir).check(c.candidate);
    out.push({
      id: c.id,
      expectTag: c.expectTag,
      got: v !== null,
      reason: v?.reason ?? "",
      expectReason: c.expectReason ?? "",
      source: c.source,
    });
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  return out;
}

/** Hits with a budget too small for a single line: the harness's own fuse. */
async function scoreArmHeaderOnly(rows: Memory[]): Promise<number> {
  let hits = 0;
  for (const q of QUERIES.slice(0, 12)) {
    const { block } = await selectRelevant(
      q.q,
      30,
      rows,
      undefined,
      undefined,
      {
        budget: 4,
      },
    );
    if (block.trim().length > 0) hits++;
  }
  return hits;
}

process.exitCode = failed ? 1 : 0;
