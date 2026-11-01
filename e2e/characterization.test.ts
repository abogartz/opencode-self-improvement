// Characterization suite for the nine tools the terminal gate never exercised
// end-to-end (#241): memory_update, memory_undo, memory_export, memory_import,
// memory_decay, memory_consolidate, memory_merge_review, memory_evidence and
// memory_init. Each scenario drives a REAL opencode host against the scripted
// fake model over a fresh isolated store and pins the tool's CURRENT
// host-facing contract: schema acceptance, result shaping, gate interaction,
// and the store files left behind. These are specification-first tests: they
// describe shipped behavior exactly as observed, so a flow can change only
// through an intentional, visible red.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, type Fake, type Guest, makeGuest, startFake, turn } from "./support/harness.ts";

let fake: Fake;
const guests: Guest[] = [];
// Fakes spun up inside a scenario (the two-host race) get reaped too.
const extraFakes: Fake[] = [];

beforeAll(async () => {
  fake = await startFake();
});
afterEach(() => {
  for (const g of guests.splice(0)) rmSync(g.root, { recursive: true, force: true });
  for (const f of extraFakes.splice(0)) f.stop();
});
afterAll(() => fake.stop());

function guest(): Guest {
  const g = makeGuest(fake, REPO);
  guests.push(g);
  return g;
}

/** A scripted assistant tool_call step. `args` is the tool-call JSON object. */
function call(id: string, tool: string, args: Record<string, unknown>) {
  return { tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] };
}

const FACT =
  "the flimflam widget pipeline on the arm64 build box compiles with bun build using the " +
  "standard tsconfig defaults in single pass mode without any extra flags at all today";

function canonicalLines(memoryDir: string): string[] {
  return readdirSync(memoryDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.logfmt$/.test(f))
    .flatMap((f) => readFileSync(join(memoryDir, f), "utf8").trim().split("\n").filter(Boolean));
}

function rowWith(memoryDir: string, needle: string): string {
  const row = canonicalLines(memoryDir).find((l) => l.includes(needle));
  expect(row, `store row containing "${needle}"`).toBeString();
  return row as string;
}

function tsOf(row: string): string {
  const m = /^ts=(\S+)/.exec(row);
  expect(m, `row starts with a ts= field: ${row.slice(0, 80)}`).not.toBeNull();
  return m![1];
}

const UTC_DAY = () => new Date().toISOString().split("T")[0];

describe("Feature: host-facing contract of the nine untested tools (#241)", () => {
  // @covers hook:session.prompt hook:tool.execute.before hook:tool.execute.after hook:event.subscribe
  test("Scenario: memory_update retires the old row, refuses ambiguity and bad selectors", async () => {
    const g = guest();
    const REPLACEMENT = "the triskelion alpha widget cadence moved to a fortnightly review with the vendor";
    fake.setSteps({
      "SMOKE::upd": [
        call("u0", "memory_remember", {
          type: "learning",
          scope: "flimflam",
          content: "triskelion alpha widget cadence: the team prunes the retro board every tuesday",
          status: "open",
        }),
        call("u1", "memory_remember", {
          type: "learning",
          scope: "flimflam",
          content: "triskelion beta gadget rollout hides behind a desktop flag toggled at boot",
          status: "open",
        }),
        call("u2", "memory_update", {
          type: "learning",
          scope: "flimflam",
          content: REPLACEMENT,
          query: "widget cadence",
        }),
        call("u3", "memory_update", {
          type: "learning",
          scope: "flimflam",
          content: REPLACEMENT,
          query: "triskelion",
        }),
        call("u4", "memory_update", {
          type: "learning",
          scope: "flimflam",
          content: REPLACEMENT,
          query: "pentagonal-token-that-names-nothing",
        }),
        { content: "UPD-DONE" },
      ],
    });

    const run = await turn(fake, g, "SMOKE::upd store two notes, update one, then try ambiguous and nonsense selectors");

    expect(run.exit).toBe(0);
    expect(run.errors()).toEqual([]);
    const [updated, ambiguous, missing] = run.outputs("memory_update");
    // Then the named row is replaced: promoted + retired, named in the reply.
    expect(updated).toMatch(/^Updated learning in flimflam \(superseded \d{4}-\d{2}-\d{2}T/);
    // A selector matching several live rows fails closed and NAMES the rivals,
    // so the caller can disambiguate instead of guessing.
    expect(ambiguous).toInclude('memory_update blocked: "triskelion" matches 2 active learning rows in flimflam');
    expect(ambiguous).toInclude("Nothing was written");
    // And an unmatched selector writes nothing and says so.
    expect(missing).toInclude("memory_update blocked: no active learning row in flimflam");
    expect(missing).toInclude("Nothing was written");

    // Three rows on disk: two replacements' worth of state and the untouched
    // beta note — the refused calls added nothing.
    const rows = canonicalLines(g.memoryDir);
    expect(rows.length).toBe(3);
    const old = rowWith(g.memoryDir, "widget cadence: the team prunes");
    const rep = rowWith(g.memoryDir, "fortnightly review");
    expect(old).toInclude(`superseded_by=${tsOf(rep)}`);
    expect(rep).not.toInclude("superseded_by=");
    expect(rowWith(g.memoryDir, "beta gadget rollout")).not.toInclude("superseded_by=");
  }, 240_000);

  test("Scenario: memory_undo lists the update's snapshot; check refuses, merge restores", async () => {
    // Given a fresh store where an update retires a row (snapshot-first)
    const g = guest();
    const NEW = "the flimflam nightly now packages with docker buildx bake instead of the old shell script";
    fake.setSteps({
      "SMOKE::undo-1": [
        call("n1", "memory_remember", { type: "learning", scope: "flimflam", content: FACT, status: "open" }),
        call("n2", "memory_update", { type: "learning", scope: "flimflam", content: NEW, query: "widget" }),
        { content: "UNDO-SETUP" },
      ],
    });
    const setup = await turn(fake, g, "SMOKE::undo-1 store the fact then update it");
    expect(setup.exit).toBe(0);
    expect(setup.outputs("memory_update")[0]).toInclude("Updated");
    const snapDir = join(g.memoryDir, "snapshots");
    const snapName = readdirSync(snapDir).find((f) => /\.logfmt/.test(f));
    expect(snapName, "the supersede snapshotted the day file").toBeString();

    // When the same session lists snapshots, then restores check-mode, then merge
    fake.setSteps({
      "SMOKE::undo-2": [
        call("n3", "memory_undo", {}),
        call("n4", "memory_undo", { snapshot: snapName }),
        call("n5", "memory_undo", { snapshot: snapName, merge: true }),
        { content: "UNDO-DONE" },
      ],
    });
    const run = await turn(fake, g, "SMOKE::undo-2 list snapshots and undo the update");

    expect(run.exit).toBe(0);
    expect(run.errors()).toEqual([]);
    const [listing, refused, restored] = run.outputs("memory_undo");
    // The list is name + byte count, exactly what a caller feeds back in.
    expect(listing).toInclude(snapName!);
    expect(listing).toMatch(/\(\d+ bytes\)/);
    // The day file moved after the snapshot (the update itself), so plain
    // restore refuses and points at the modes.
    expect(refused).toInclude("Undo refused:");
    expect(refused).toInclude("merge=true");
    expect(restored).toMatch(/^Restored .+ from merge snapshot ->/);
    // Merge is a deliberate SUPERSET, not a rollback: rows written after the
    // snapshot are kept and tallied by name (the replacement may itself
    // predate the supersede snapshot, so only the count SHAPE is pinned).
    expect(restored).toMatch(/Kept \d+ added \/ \d+ changed row\(s\) written after the snapshot\./);
    const rows = canonicalLines(g.memoryDir);
    expect(rows.length).toBe(2);
    for (const needle of ["flimflam widget pipeline", "docker buildx bake"]) {
      const hits = rows.filter((l) => l.includes(needle));
      expect(hits.length, `${needle} appears exactly once`).toBe(1);
    }
    // The stamp survives — proving merge kept the CURRENT (superseded) version
    // rather than reviving the snapshot copy. force is the rollback mode.
    expect(rowWith(g.memoryDir, "flimflam widget pipeline")).toInclude("superseded_by=");
  }, 240_000);

  // @covers hook:session.context
  test("Scenario: memory_export writes a header-vouched JSONL artifact", async () => {
    const g = guest();
    fake.setSteps({
      "SMOKE::exp": [
        call("x1", "memory_remember", { type: "learning", scope: "flimflam", content: FACT, status: "open" }),
        call("x2", "memory_export", {}),
        call("x3", "memory_export", { file: "../outside-store.jsonl" }),
        { content: "EXP-DONE" },
      ],
    });

    const run = await turn(fake, g, "SMOKE::exp store the fact, export the store, then try escaping exports/");

    expect(run.exit).toBe(0);
    expect(run.errors()).toEqual([]);
    const out = run.outputs("memory_export")[0];
    const m = /^Exported (\d+) memories -> (\S+\.jsonl)$/.exec(out);
    expect(m, out).not.toBeNull();
    expect(Number(m![1])).toBe(1);

    // Then the artifact sits under exports/ with the machine header first.
    const artifact = readFileSync(m![2], "utf8").trim().split("\n");
    expect(m![2].replace(/\\/g, "/")).toInclude(`/exports/`);
    const header = JSON.parse(artifact[0]);
    expect(header._export).toBe("opencode-self-improvement");
    expect(header.version).toBe(1);
    expect(header.count).toBe(1);
    expect(artifact.length).toBe(2);
    expect(JSON.parse(artifact[1]).content).toInclude("flimflam widget pipeline");

    // And a destination outside the store is refused before the filesystem
    // learns whether anything exists there — no escape, no oracle.
    expect(run.outputs("memory_export")[1]).toInclude("memory_export failed");
    expect(existsSync(join(g.memoryDir, "..", "outside-store.jsonl"))).toBe(false);
  }, 240_000);

  test("Scenario: memory_import replays an export through the gate and tallies malformed lines", async () => {
    // Given a store holding nothing and an exports/incoming.jsonl with one
    // open row (header-vouched) and one unparseable line
    const g = guest();
    const expDir = join(g.memoryDir, "exports");
    mkdirSync(expDir, { recursive: true });
    writeFileSync(
      join(expDir, "incoming.jsonl"),
      [
        JSON.stringify({
          _export: "opencode-self-improvement",
          version: 1,
          exportedAt: "2026-01-01T00:00:00.000Z",
          count: 1,
        }),
        JSON.stringify({
          ts: "2026-01-01T00:00:00.000Z",
          type: "learning",
          scope: "flimflam",
          content: "imported flimflam ledger digest ships nightly at midnight to the finance box",
          status: "open",
        }),
        "this line is not json at all",
        "",
      ].join("\n"),
    );
    // And a hand-written file with no export header vouching for its frontier
    // claim: the open status is downgraded, then the grounding gate refuses it.
    writeFileSync(
      join(expDir, "handwritten.jsonl"),
      JSON.stringify({
        type: "learning",
        scope: "flimflam",
        content: "unvouched flimflam frontier claim copied from a chat log without any export header",
        status: "open",
      }) + "\n",
    );
    fake.setSteps({
      "SMOKE::imp": [
        call("m1", "memory_import", { file: join(expDir, "incoming.jsonl") }),
        call("m2", "memory_import", { file: join(expDir, "does-not-exist.jsonl") }),
        call("m3", "memory_import", { file: join(expDir, "handwritten.jsonl") }),
        call("m4", "memory_recall", { query: "flimflam ledger digest midnight" }),
        { content: "IMP-DONE" },
      ],
    });

    const run = await turn(fake, g, "SMOKE::imp import the incoming file, a missing file, and a handwritten one, then recall");

    expect(run.exit).toBe(0);
    expect(run.errors()).toEqual([]);
    // The tally names every outcome class; exactly one row promoted, the
    // garbage line skipped rather than gated.
    const [ok, missing, unvouched] = run.outputs("memory_import");
    expect(ok).toInclude("1 promoted");
    expect(ok).toInclude("0 duplicates collapsed");
    expect(ok).toInclude("0 blocked by the gate");
    expect(ok).toInclude("1 malformed lines skipped");
    // A missing file is an honest failure, not a silent zero.
    expect(missing).toInclude("memory_import failed");
    // Headerless frontier: downgraded to settled, then blocked as ungrounded.
    expect(unvouched).toInclude("0 promoted");
    expect(unvouched).toInclude("1 blocked by the gate");
    expect(unvouched).toInclude("open rows downgraded to settled");
    // And the imported row is live memory; the refused one is not.
    expect(run.outputs("memory_recall")[0]).toInclude("ledger digest");
    expect(rowWith(g.memoryDir, "ledger digest")).toInclude(`status=open`);
    expect(canonicalLines(g.memoryDir).length).toBe(1);
  }, 240_000);

  test("Scenario: memory_decay dry-runs by default and supersedes only on dryRun=false", async () => {
    // Given a store holding one six-year-old open thread, seeded directly
    const g = guest();
    writeFileSync(
      join(g.memoryDir, "2020-01-01.logfmt"),
      'ts=2020-01-01T00:00:00.000Z type=learning scope=ancient content="the ancient flimflam migration plan from the previous decade still needs an owner" status=open\n',
    );
    fake.setSteps({
      "SMOKE::dec-1": [call("z1", "memory_decay", { olderThanDays: 14 }), { content: "DEC-DRY" }],
    });

    const dry = await turn(fake, g, "SMOKE::dec-1 sweep stale open threads");

    expect(dry.exit).toBe(0);
    expect(dry.errors()).toEqual([]);
    // Default call is a preview: it lists and mutates nothing.
    expect(dry.outputs("memory_decay")[0]).toInclude("Dry run: 1 open thread(s) older than 14 days");
    expect(dry.outputs("memory_decay")[0]).toInclude("ancient flimflam migration plan");
    expect(rowWith(g.memoryDir, "ancient flimflam migration plan")).not.toInclude("superseded_by=");

    // When the same session re-runs the sweep with an explicit dryRun=false
    fake.setSteps({
      "SMOKE::dec-2": [call("z2", "memory_decay", { olderThanDays: 14, dryRun: false }), { content: "DEC-APPLY" }],
    });
    const applied = await turn(fake, g, "SMOKE::dec-2 apply the sweep now");

    expect(applied.exit).toBe(0);
    expect(applied.errors()).toEqual([]);
    // The explicit false retires by supersession, never deletion, snapshot first.
    expect(applied.outputs("memory_decay")[0]).toInclude("Decayed 1 open thread(s) older than 14 days");
    expect(applied.outputs("memory_decay")[0]).toInclude("superseded, not deleted");
    const row = rowWith(g.memoryDir, "ancient flimflam migration plan");
    expect(row).toInclude("superseded_by=decay");
    expect(existsSync(join(g.memoryDir, "snapshots"))).toBe(true);
  }, 240_000);

  test("Scenario: memory_consolidate answers a fresh store and writes nothing", async () => {
    const g = guest();
    fake.setSteps({
      "SMOKE::con": [call("k1", "memory_consolidate", {}), { content: "CON-DONE" }],
    });

    const run = await turn(fake, g, "SMOKE::con propose consolidations");

    expect(run.exit).toBe(0);
    expect(run.errors()).toEqual([]);
    // The header promises read-only, and with no proved cluster the body is the
    // honest none-line.
    expect(run.outputs("memory_consolidate")[0]).toInclude(
      "CONSOLIDATION PROPOSALS — nothing was written",
    );
    expect(run.outputs("memory_consolidate")[0]).toInclude(
      "none — no cluster proved it could hold its reads",
    );
    expect(canonicalLines(g.memoryDir)).toEqual([]);
  }, 240_000);

  test("Scenario: memory_merge_review fails closed without a reason and resolves the loser", async () => {
    // Given two active sibling rows whose ids the test reads off the store
    const g = guest();
    const A = "the flimflam alpha-widget cadence review meets every tuesday to prune stale board items";
    const B = "the flimflam beta-gadget rollout ships behind a feature flag toggled in the desktop app";
    fake.setSteps({
      "SMOKE::mrg-1": [
        call("q1", "memory_remember", { type: "learning", scope: "flimflam", content: A, status: "open" }),
        call("q2", "memory_remember", { type: "learning", scope: "flimflam", content: B, status: "open" }),
        { content: "MRG-SEED" },
      ],
    });
    const seed = await turn(fake, g, "SMOKE::mrg-1 store both sibling facts");
    expect(seed.exit).toBe(0);
    expect(canonicalLines(g.memoryDir).length).toBe(2);
    const loser = tsOf(rowWith(g.memoryDir, "alpha-widget"));
    const survivor = tsOf(rowWith(g.memoryDir, "beta-gadget"));

    // When the same session tries an empty-reason resolve, then a real one
    fake.setSteps({
      "SMOKE::mrg-2": [
        call("q3", "memory_merge_review", { loser: "", survivor: "", reason: "" }),
        call("q4", "memory_merge_review", {
          loser,
          survivor: "2099-01-01T00:00:00.000Z",
          reason: "names a row that is not in the store",
        }),
        call("q5", "memory_merge_review", { loser, survivor, reason: "e2e characterization" }),
        { content: "MRG-DONE" },
      ],
    });
    const run = await turn(fake, g, "SMOKE::mrg-2 resolve the merge gate three ways");

    expect(run.exit).toBe(0);
    expect(run.errors()).toEqual([]);
    const [blocked, ghost, resolved] = run.outputs("memory_merge_review");
    expect(blocked).toInclude("loser, survivor, and reason are all required (fail-closed)");
    // A survivor that does not exist cannot canonize anything: fail closed,
    // and the message says no evidence was written.
    expect(ghost).toInclude("survivor 2099-01-01T00:00:00.000Z does not exist in the store");
    expect(ghost).toInclude("No evidence written");
    // The resolution names both rows and the durable follow-up.
    expect(resolved).toInclude(`Resolved merge: ${survivor} is canonical; ${loser} superseded`);
    expect(resolved).toInclude("Evidence recorded for reason='e2e characterization'");
    // Store side: the loser carries the survivor pointer; nothing was deleted.
    const row = rowWith(g.memoryDir, "alpha-widget");
    expect(row).toInclude(`superseded_by=${survivor}`);
    expect(canonicalLines(g.memoryDir).length).toBe(2);
  }, 240_000);

  test("Scenario: memory_evidence replays the turn's audit line and refuses impossible dates", async () => {
    const g = guest();
    fake.setSteps({
      "SMOKE::evi": [
        call("w1", "memory_remember", { type: "learning", scope: "flimflam", content: FACT, status: "open" }),
        call("w2", "memory_evidence", { date: UTC_DAY() }),
        call("w3", "memory_evidence", { date: "2026-13-45" }),
        { content: "EVI-DONE" },
      ],
    });

    const run = await turn(fake, g, "SMOKE::evi store the fact then read today's evidence, then a fake date");

    expect(run.exit).toBe(0);
    expect(run.errors()).toEqual([]);
    // Same-session writes are auditable the same day, through the host.
    expect(run.outputs("memory_evidence")[0]).toInclude("write_promoted");
    // Format-passing but calendar-impossible dates are refused, not read.
    expect(run.outputs("memory_evidence")[1]).toInclude(
      "memory_evidence blocked: date must be a real YYYY-MM-DD calendar date",
    );
  }, 240_000);

  test("Scenario: memory_init derives scripts through the gate and is idempotent at the same head", async () => {
    // Given a project whose only manifest is a package.json with notable scripts
    const g = guest();
    writeFileSync(
      join(g.projDir, "package.json"),
      JSON.stringify({ name: "e2e-init-probe", scripts: { test: "echo t", lint: "echo l", ship: "echo s" } }),
    );
    fake.setSteps({
      "SMOKE::ini": [
        call("i1", "memory_init", {}),
        call("i2", "memory_init", {}),
        { content: "INI-DONE" },
      ],
    });

    const run = await turn(fake, g, "SMOKE::ini initialize this repository, then initialize again");

    expect(run.exit).toBe(0);
    expect(run.errors()).toEqual([]);
    const [first, second] = run.outputs("memory_init");
    // First run: scripts detected (ship is not a notable key), rows promoted,
    // a graph line whatever the machine has — the shape is the contract.
    expect(first).toInclude("Initialized ");
    expect(first).toMatch(/Graph: (indexed|unavailable|index-failed)/);
    expect(first).toInclude("Scripts (2):");
    expect(first).toInclude('npm run test');
    expect(first).not.toInclude("npm run ship");
    expect(first).toMatch(/Memories: written=\d+, collapsed=\d+, blocked=\d+; stamp=\S+/);
    // Second run at the same head: no-op, by stamp.
    expect(second).toInclude("Already initialized for ");
    expect(second).toInclude("Nothing to do.");
    // The derived commands are durable memories.
    expect(rowWith(g.memoryDir, "npm run test")).toInclude("type=pattern");
  }, 240_000);

  // @covers hook:session.prompt hook:tool.execute.before hook:tool.execute.after hook:event.subscribe
  test("Scenario: two hosts racing one shared store both win and nothing interleaves", async () => {
    // Given two fully independent real hosts (own processes, own scripted
    // model) pointed at ONE store: the shared store lock is the only thing
    // between them and a torn day file.
    const fakeB = await startFake();
    extraFakes.push(fakeB);
    const gA = guest();
    const gB = makeGuest(fakeB, REPO);
    guests.push(gB);
    // Share the store by env re-point, not a symlink: symlink creation needs
    // privilege on Windows, and the env var is the store's only input anyway.
    gB.env.OPENCODE_MEMORY_DIR = gA.memoryDir;

    const RACE_A =
      "the race probe alpha from host one records that the shared ledger survived the collision drill";
    const RACE_B =
      "the race probe beta from host two records that the shared ledger kept every append intact";
    fake.setSteps({
      "RACE::a": [call("r1", "memory_remember", { type: "learning", scope: "race", content: RACE_A, status: "open" }), { content: "RACE-A" }],
    });
    fakeB.setSteps({
      "RACE::b": [call("r2", "memory_remember", { type: "learning", scope: "race", content: RACE_B, status: "open" }), { content: "RACE-B" }],
    });

    // When both write at the same time
    const [runA, runB] = await Promise.all([
      turn(fake, gA, "RACE::a store probe alpha"),
      turn(fakeB, gB, "RACE::b store probe beta"),
    ]);

    // Then both turns are healthy — the lock serializes, it never deadlocks
    // or fails the loser.
    expect(runA.exit).toBe(0);
    expect(runB.exit).toBe(0);
    expect(runA.errors()).toEqual([]);
    expect(runB.errors()).toEqual([]);
    expect(runA.outputs("memory_remember")[0]).toInclude("Remembered");
    expect(runB.outputs("memory_remember")[0]).toInclude("Remembered");

    // And the shared store holds exactly the two rows, each as one intact
    // record: no interleaved halves, no lost append.
    const rows = canonicalLines(gA.memoryDir);
    expect(rows.length).toBe(2);
    for (const l of rows) expect(l).toMatch(/^ts=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z type=learning /);
    expect(rows.some((l) => l.includes("probe alpha"))).toBe(true);
    expect(rows.some((l) => l.includes("probe beta"))).toBe(true);
    // And the run left no lock file behind on either host (bounded poll so a
    // just-exited process's unlink cannot race the assertion).
    const lockDeadline = Date.now() + 2_000;
    let locks = readdirSync(gA.memoryDir).filter((f) => f.endsWith(".lock"));
    while (locks.length && Date.now() < lockDeadline) {
      await Bun.sleep(100);
      locks = readdirSync(gA.memoryDir).filter((f) => f.endsWith(".lock"));
    }
    expect(locks).toEqual([]);
  }, 240_000);
});
