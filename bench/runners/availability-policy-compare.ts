// Availability policy comparison (issue #402, phase P4): does turning the
// availability REFUSAL into a TAG actually win anything, measured on a store
// built only by the shipped capture path?
//
// Four arms over ONE identical capture pass — same fake repo, same scripted
// model reply, same distractors — differing only in what the availability
// verdict does:
//
//   off               no availability check at all
//   tag               #403 as shipped: store the row, tag it `restatable`,
//                     retrieval gives it up first under a byte budget
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
// `off` hold the same rows), and each win claim. A harness that cannot fail does
// not count.
//
//   bun bench/runners/availability-policy-compare.ts
import {
  appendFileSync,
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
import { selectRelevant } from "../../src/recall/relevant.ts";
import { buildStore, MEMORIES, QUERIES } from "../fixtures/recall-dataset.ts";
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

// --- the `362655c` reproduction ----------------------------------------------------
//
// The original check opened with `if (gate) return refuse` and no residual test:
// stating a declared command WAS the verdict. Reproduced here, and pinned by
// control 3, because the module that did it no longer exists in src.
function originalRuleRefuses(content: string): boolean {
  const spans = [...content.matchAll(/`([^`\n]{2,60})`/g)]
    .map((m) => (m[1] ?? "").trim())
    .filter(Boolean);
  const runner =
    /^(?:bun(?:x| run)?|npm (?:run|exec)|pnpm (?:run|exec)|yarn|make|task)\s+/;
  return spans.some((s) => {
    const forms = [s.toLowerCase(), s.toLowerCase().replace(runner, "")];
    return forms.some((f) =>
      SCRIPTS.some((g) =>
        g.includes(" ")
          ? f === g || f.startsWith(`${g} `)
          : f === g || f.split(" ")[0] === g,
      ),
    );
  });
}

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
  const goldIds = new Set([...TRANSPORT.map((m) => m.id)]);
  const distractors = buildStore(600)
    .filter(
      (m) =>
        !goldIds.has(m.id.split("#")[0]!) &&
        m.type !== "decision" &&
        m.type !== "preference",
    )
    .slice(0, 30);
  mkdirSync(process.env.OPENCODE_MEMORY_DIR, { recursive: true });
  appendFileSync(
    join(process.env.OPENCODE_MEMORY_DIR, `${dateStr()}.logfmt`),
    distractors
      .map((d) =>
        formatLine({
          ts: `2026-01-01T00:00:0${(d.id.length % 9) + 1}.000Z`,
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

  // Verdicts from the SHIPPED check, over the shipped rows.
  const idx = availabilityIndex(repo);
  const verdict = new Map(stored.map((m) => [m.ts, idx.check(m.content)]));
  const tagged = stored.filter((m) => m.tags?.includes(RESTATABLE_TAG));
  /** Restatable by the shipped check, independent of what each arm stored. */
  const isRestatable = (m: Memory): boolean => verdict.get(m.ts) !== null;
  const originalKills = stored.filter((m) => originalRuleRefuses(m.content));

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

  const arms: Record<string, Memory[]> = {
    off: stored.map((m) => ({ ...m, tags: ["auto-capture"] })),
    tag: stored,
    "delete-hardened": stored.filter((m) => !m.tags?.includes(RESTATABLE_TAG)),
    "delete-original": stored.filter((m) => !originalRuleRefuses(m.content)),
  };
  for (const k of Object.keys(arms)) arms[k] = [...arms[k]!, guidedRow];

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
        if (verdict.get(m.ts) === null) continue;
        const line = formatMemory(m);
        if (block.includes(line)) c.restatableBytes += line.length;
      }
      if (block.includes(formatMemory(guidedRow))) c.guidedRides++;
      if (process.env.AVAIL_DUMP && budget === Math.round(FULL * 0.4))
        console.log(`DUMP ${q.q.slice(0, 34)}\n${block}\n`);
    }
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

  const names = ["off", "tag", "delete-hardened", "delete-original"] as const;
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
    rows.filter((m) => m.ts !== guidedRow.ts && verdict.get(m.ts) !== null)
      .length;
  const transportStored = (rows: Memory[]) =>
    TRANSPORT.filter((g) =>
      rows.some((m) => m.content.includes(withCommand(g.content).slice(0, 60))),
    ).length;

  const lines: string[] = [];
  lines.push("# Availability: tag vs delete — measured on one capture pass");
  lines.push("");
  lines.push(
    `${stored.length} rows written by the shipped capture path over ${candidates.length} scripted ` +
      `candidates, ${distractors.length} equal distractors, ${transportQueries.length} dataset queries ` +
      `+${documentedQueries.length} doc queries. Verdicts from the shipped availabilityIndex; selection ` +
      `by the shipped selectRelevant with its real byte budget. Budgets are fractions of the ` +
      `unbudgeted block (${FULL} bytes).`,
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
    "| budget | transport facts in block | restatable bytes in block | doc facts in block |",
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

  const controls: string[] = [];
  const check = (ok: boolean, label: string) => {
    controls.push(`${ok ? "PASS" : "FAIL"} — ${label}`);
    if (!ok) failed = true;
  };
  const tight = FRACS[FRACS.length - 2]!;

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
    originalKills.length === TRANSPORT_WITH_COMMAND.length,
    `the 362655c reproduction bites exactly its target population: ${originalKills.length}/${TRANSPORT_WITH_COMMAND.length} command-stating facts refused — RED if the reproduction drifts`,
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
    `WIN vs the original rule: tag delivers ${cell("tag", tight).transportHits}/${transportQueries.length} transport facts at the binding budget, delete-original ${cell("delete-original", tight).transportHits}, and tag is never behind at any budget (${col("tag", "transportHits")} vs ${col("delete-original", "transportHits")}) — a deleted fact cannot be retrieved`,
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
    restatableStored(arms["delete-hardened"]!) === 0 &&
      restatableStored(arms.tag!) > 0,
    `deleting is not free: the tag arm keeps ${restatableStored(arms.tag!)} restatable facts a budget can still surface; #397's policy keeps ${restatableStored(arms["delete-hardened"]!)}, unreachable at any budget`,
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
