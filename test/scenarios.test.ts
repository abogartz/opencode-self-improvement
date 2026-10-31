// Behavior suite for the plugin contract. Hermetic: OPENCODE_MEMORY_DIR is
// pointed at a per-test temp dir and the "live" source tree is a throwaway, so
// nothing here touches this repo or the real memory store.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { dirname, join } from "node:path";
import { dateStr, evidenceDir, memoryRoot, snapshotDir } from "../src/config.ts";
import { formatLine, parseLine, type Fields } from "../src/logfmt.ts";
import { loadAll } from "../src/memory.ts";
import { runWriteGate, type GateContext } from "../src/gates.ts";
import { pruneMemory } from "../src/prune.ts";
import { contextualPull, systemDigest } from "../src/inject.ts";
import { afterTool, evidenceCalls, hasGateCheck } from "../src/triggers.ts";
import { resetState, setCurrent } from "../src/state.ts";
import { rememberSessionDir } from "../src/repokey.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function seed(type: string, scope: string, content: string, ts = new Date().toISOString()): string {
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, formatLine({ ts, type, scope, content }) + "\n");
  return ts;
}

function writeCanonical(fields: Record<string, string>): void {
  mkdirSync(memoryRoot(), { recursive: true });
  appendFileSync(join(memoryRoot(), "canonical.logfmt"), formatLine(fields) + "\n");
}

function evidence(): Fields[] {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseLine(l))
    .filter((f): f is Fields => f !== null);
}

function ev(lines: Fields[], name: string): Fields[] {
  return lines.filter((l) => l.ev === name);
}

function field(line: Fields | undefined, key: string): string {
  return line ? String(line[key] ?? "") : "";
}

function assertOrder(lines: Fields[], expected: string[]): void {
  let i = 0;
  for (const l of lines) {
    if (l.ev === expected[i]) i++;
    if (i === expected.length) break;
  }
  expect(i).toBe(expected.length);
}

function gateOrder(lines: Fields[], chain: string): number[] {
  const nums = lines
    .filter((l) => String(l.chain) === chain && typeof l.gate === "string")
    .map((l) => Number(l.gate));
  // Consecutive repeats are the same gate emitting several lines (GATE-2 has
  // ref_stale / superseded_by). Collapse them to the gate sequence.
  return nums.filter((n, i) => i === 0 || n !== nums[i - 1]);
}

function ctx(sid: string): GateContext {
  // This gate call runs for `sid` IN liveRoot. A real host states the same
  // thing by handing every tool execute a sessionID this instance resolves;
  // a named session with no repository has no write target (#152), so the
  // scenario harness has to declare the workspace it is simulating.
  rememberSessionDir(sid, liveRoot);
  return {
    liveRoot,
    evidenceCalls: evidenceCalls(sid),
    hasGateCheck: hasGateCheck(sid),
  };
}

async function call(
  sid: string,
  callID: string,
  tool: string,
  args: Record<string, unknown>,
  output: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  setCurrent({ sessionID: sid, callID, tool });
  await afterTool({ tool, sessionID: sid, callID, args }, { output, metadata });
}

function durableFileContents(): string {
  return loadAllSync();
}

function loadAllSync(): string {
  const glob = new Bun.Glob("*.logfmt").scanSync(memoryRoot());
  let text = "";
  for (const f of glob) {
    if (["canonical.logfmt", "deletions.logfmt", "deleted.logfmt"].includes(f)) continue;
    text += readFileSync(join(memoryRoot(), f), "utf8");
  }
  return text;
}

describe("S1 — signature-update-turn (anchor contract)", () => {
  test("drift→stale→supersede→clean→promote, evidence-chain and gate-coupled both hold", async () => {
    writeFileSync(
      join(liveRoot, "table_manager.ts"),
      "export function save(config, opts) {\n  return [config, opts];\n}\n",
    );
    const T1 = seed("pattern", "ctl", "use table_manager.save(opts)");
    const sid = "s1";

    await call(sid, "C1", "bash", { command: "npx vitest run" }, "FAIL: save expects 2 args", {
      exitCode: 1,
    });
    await call(sid, "C2", "grep", { pattern: "save" }, "3 matches found");
    await call(sid, "C3", "read", { filePath: "table_manager.ts" }, "export function save…");
    await call(sid, "C4", "edit", { filePath: "table_manager.ts" }, "edit ok");
    await call(sid, "C5", "bash", { command: "npx vitest run" }, "PASS", { exitCode: 0 });

    setCurrent({ sessionID: sid, callID: "C6", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "pattern", scope: "ctl", content: "use table_manager.save(config, opts)" },
      ctx(sid),
    );
    expect(outcome.action).toBe("promoted");

    const lines = evidence();
    assertOrder(lines, [
      "gate_start",
      "graph_drift",
      "ref_stale_scan",
      "ref_stale",
      "superseded_by",
      "dedup_clean",
      "write_promoted",
    ]);

    // Assert A (data-path).
    expect(ev(lines, "graph_current").length).toBe(0);
    expect(ev(lines, "write_blocked").length).toBe(0);
    expect(ev(lines, "dedup_overlap").length).toBe(0);

    const gs = ev(lines, "gate_start")[0];
    const gd = ev(lines, "graph_drift")[0];
    expect(field(gd, "from")).toBe("save(opts)");
    expect(field(gd, "to")).toBe("save(config, opts)");
    expect(field(gd, "corrected")).toBe("true");

    const scan = ev(lines, "ref_stale_scan")[0];
    expect(field(scan, "scanned")).toBe("1");
    expect(field(scan, "found")).toBe("1");
    expect(field(scan, "bailed")).toBe("false");

    const sb = ev(lines, "superseded_by")[0];
    expect(field(sb, "mem")).toBe(T1);
    expect(field(sb, "target")).toBe(field(gs, "chain"));
    expect(field(sb, "reason")).toBe("drift");

    const wp = ev(lines, "write_promoted")[0];
    expect(field(wp, "supersedes")).toBe(T1);
    const refs = field(wp, "evidence_refs");
    for (const c of ["C1", "C4", "C5"]) expect(refs).toContain(c);

    // I0 no-bypass: exactly one new durable line, ts matches write_promoted.mem.
    const durable = await loadAll();
    const active = durable.filter((m) => !m.superseded_by);
    expect(active.length).toBe(1);
    expect(active[0].ts).toBe(field(wp, "mem"));
    const m1 = durable.find((m) => m.ts === T1);
    expect(m1?.superseded_by).toBeTruthy();

    // I1 gate order 1→2→3→4 within the chain.
    expect(gateOrder(lines, field(gs, "chain"))).toEqual([1, 2, 3, 4]);

    // Repo-hermetic: the snapshot path is under the memory root, not the repo.
    expect(field(wp, "snapshot")).toContain(memoryRoot());
    expect(field(wp, "snapshot")).not.toContain(liveRoot);
  });
});

describe("S2 — blank/ambiguous-memory (capture yes, promote no)", () => {
  test("blocks with ambiguous_memory, no durable write, T1 capture present", async () => {
    const sid = "s2";
    await call(sid, "c1", "grep", { pattern: "needle-a" }, "No matches found");
    await call(sid, "c2", "grep", { pattern: "needle-b" }, "3 matches found");

    setCurrent({ sessionID: sid, callID: "c3", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "learning", scope: "", content: "tests pass now" },
      ctx(sid),
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("ambiguous_memory");

    const lines = evidence();
    assertOrder(lines, [
      "t1_evidence",
      "gate_start",
      "graph_current",
      "ref_stale_scan",
      "dedup_clean",
      "write_blocked",
    ]);
    const t1 = ev(lines, "t1_evidence")[0];
    expect(field(t1, "from")).toBe("FAIL");
    expect(field(t1, "to")).toBe("PASS");
    expect(field(t1, "evidence_refs")).toBe("[c1,c2]");

    expect(field(ev(lines, "graph_current")[0], "refs")).toBe("0");
    expect(field(ev(lines, "ref_stale_scan")[0], "bailed")).toBe("true");
    const blocked = ev(lines, "write_blocked")[0];
    expect(field(blocked, "gate")).toBe("4");
    expect(field(blocked, "reason")).toBe("ambiguous_memory");
    expect(field(blocked, "flags")).toBe("[empty_scope,no_embedded_refs,no_evidence_refs]");

    expect((await loadAll()).length).toBe(0);
  });
});

describe("S3 — duplicate-write-attempt (Principle 2)", () => {
  test("collapses internally with no GATE-4 line; store byte-identical", async () => {
    const T1 = seed("learning", "auth", "use bcrypt for password hashing");
    const sid = "s3";
    const before = durableFileContents();

    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "learning", scope: "auth", content: "use bcrypt for password hashing" },
      ctx(sid),
    );
    expect(outcome.action).toBe("collapsed");

    const lines = evidence();
    assertOrder(lines, ["gate_start", "graph_current", "ref_stale_scan", "dedup_collapse"]);
    const dc = ev(lines, "dedup_collapse")[0];
    expect(field(dc, "match")).toBe(T1);
    expect(field(dc, "action")).toBe("canonical_existing");
    expect(field(dc, "incoming_ignored")).toBe("true");
    expect(ev(lines, "write_promoted").length).toBe(0);
    expect(ev(lines, "write_blocked").length).toBe(0);
    expect(durableFileContents()).toBe(before);
  });
});

describe("S4 — superseded-memory, decision-fed, no registry (review-gated)", () => {
  test("proposes a merge, blocks, never auto-supersedes", async () => {
    const M1 = seed("decision", "backend", "use Express for API routing");
    const M2 = seed("decision", "backend", "use Fastify for API routing");
    const sid = "s4";
    const before = durableFileContents();

    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "decision", scope: "backend", content: "use Fastify for API routing" },
      ctx(sid),
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("superseded_overlap");
    expect(outcome.hint).toContain("memory_update");

    const lines = evidence();
    assertOrder(lines, [
      "gate_start",
      "graph_current",
      "ref_stale_scan",
      "dedup_overlap",
      "write_blocked",
      "merge_proposal",
    ]);
    const overlap = ev(lines, "dedup_overlap")[0];
    expect(field(overlap, "candidate")).toBe(M1);
    expect(field(overlap, "action")).toBe("propose_merge");
    expect(ev(lines, "superseded_by").length).toBe(0);
    expect(ev(lines, "write_promoted").length).toBe(0);

    const merge = ev(lines, "merge_proposal")[0];
    expect(field(merge, "candidate")).toBe(M1);
    expect(field(merge, "canonical")).toBe(M2);
    expect(field(merge, "review")).toBe("advisory");
    expect(field(merge, "incoming_stored")).toBe("false");
    expect(durableFileContents()).toBe(before);
  });
});

describe("S4b — canonical registry supersession", () => {
  test("i — canonical aligns: auto-supersede and promote", async () => {
    const M1 = seed("decision", "backend", "use Express for API routing");
    writeCanonical({
      ts: "REG-1",
      type: "canonical",
      entity: "API routing",
      value: "Fastify",
      scope: "backend",
      source: "AGENTS.md:42",
      review: "approved",
    });
    const sid = "s4b-i";
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "decision", scope: "backend", content: "use Fastify for API routing" },
      ctx(sid),
    );
    expect(outcome.action).toBe("promoted");

    const lines = evidence();
    assertOrder(lines, [
      "gate_start",
      "graph_current",
      "canonical_hit",
      "superseded_by",
      "dedup_clean",
      "write_promoted",
    ]);
    const hit = ev(lines, "canonical_hit")[0];
    expect(field(hit, "entity")).toBe("API routing");
    expect(field(hit, "value")).toBe("Fastify");
    expect(field(hit, "source")).toBe("AGENTS.md:42");
    const sb = ev(lines, "superseded_by")[0];
    expect(field(sb, "mem")).toBe(M1);
    expect(field(sb, "reason")).toBe("canonical");
    expect(field(sb, "from")).toBe("Express");
    expect(field(sb, "to")).toBe("Fastify");
    const wp = ev(lines, "write_promoted")[0];
    expect(field(wp, "supersedes")).toBe(M1);
    expect(field(wp, "canonical")).toBe("canonical.logfmt:REG-1");
  });

  test("ii — anti-canonical incoming: losing memory dies, incoming blocked", async () => {
    const M1 = seed("decision", "backend", "use Express for API routing");
    writeCanonical({
      ts: "REG-1",
      type: "canonical",
      entity: "API routing",
      value: "Fastify",
      scope: "backend",
      source: "AGENTS.md:42",
      review: "approved",
    });
    const sid = "s4b-ii";
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "decision", scope: "backend", content: "use Express for API routing" },
      ctx(sid),
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("conflicts_with_canonical");

    const lines = evidence();
    const sb = ev(lines, "superseded_by")[0];
    expect(field(sb, "mem")).toBe(M1);
    expect(field(sb, "target")).toBe("<-");
    expect(field(sb, "reason")).toBe("canonical");
    const blocked = ev(lines, "write_blocked")[0];
    expect(field(blocked, "reason")).toBe("conflicts_with_canonical");
    expect(field(blocked, "flags")).toBe("[canonical=Fastify,incoming=Express]");
    expect(ev(lines, "write_promoted").length).toBe(0);
    const durable = await loadAll();
    expect(durable.find((m) => m.ts === M1)?.superseded_by).toBeTruthy();
  });

  test("iii — canonical echo: collapses on the matching durable entry", async () => {
    seed("decision", "backend", "use Express for API routing");
    const M2 = seed("decision", "backend", "use Fastify for API routing");
    writeCanonical({
      ts: "REG-1",
      type: "canonical",
      entity: "API routing",
      value: "Fastify",
      scope: "backend",
      source: "AGENTS.md:42",
      review: "approved",
    });
    const sid = "s4b-iii";
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "decision", scope: "backend", content: "use Fastify for API routing" },
      ctx(sid),
    );
    expect(outcome.action).toBe("collapsed");
    const lines = evidence();
    expect(ev(lines, "canonical_hit").length).toBe(1);
    expect(field(ev(lines, "dedup_collapse")[0], "match")).toBe(M2);
    expect(ev(lines, "write_promoted").length).toBe(0);
  });
});

describe("S4c — distinct decisions/preferences coexist (conflict floor)", () => {
  test("a topically distinct second preference in the same scope stores clean", async () => {
    seed("preference", "workflow", "prefer small focused pull requests that ship one reviewable change each");
    const sid = "s4c";
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      {
        type: "preference",
        scope: "workflow",
        content: "always rebase feature branches onto main before opening a pull request for review",
      },
      { ...ctx(sid), hasGateCheck: true },
    );
    expect(outcome.action).toBe("promoted");

    const lines = evidence();
    expect(ev(lines, "dedup_clean").length).toBe(1);
    expect(ev(lines, "dedup_overlap").length).toBe(0);
    expect(ev(lines, "write_blocked").length).toBe(0);
  });

  test("a rival preference over the floor stays review-gated, with an actionable hint", async () => {
    const M1 = seed("preference", "style", "preference use tabs for indentation in all ts files");
    const sid = "s4c-rival";
    const before = durableFileContents();
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      {
        type: "preference",
        scope: "style",
        content: "preference use spaces for indentation in all ts files",
      },
      { ...ctx(sid), hasGateCheck: true },
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("superseded_overlap");
    expect(outcome.hint).toContain(M1);
    expect(outcome.hint).toContain("memory_update");

    const lines = evidence();
    expect(field(ev(lines, "write_blocked")[0], "flags")).toBe(
      `[supersedes_check_${M1},score=0.8,review_gated]`,
    );
    const merge = ev(lines, "merge_proposal")[0];
    expect(field(merge, "review")).toBe("advisory");
    expect(field(merge, "incoming_stored")).toBe("false");
    expect(durableFileContents()).toBe(before);
  });
});

describe("S4d — an update's supersession target is never its own rival", () => {
  const LINT =
    "the lint step in the build pipeline runs eslint over every packages directory source tree " +
    "and reports unused imports exports and dead code in the final summary";
  const REWRITE =
    "the lint step in the build pipeline runs oxlint over every packages directory source tree " +
    "and reports unused imports exports and dead code in the final summary";

  test("a heavy rewording naming no target still conflicts", async () => {
    seed("learning", "lint", LINT);
    const sid = "s4d-plain";
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "learning", scope: "lint", content: REWRITE },
      { ...ctx(sid), hasGateCheck: true },
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("superseded_overlap");
  });

  test("the same rewording with supersedesTs lands", async () => {
    const M1 = seed("learning", "lint", LINT);
    const sid = "s4d-update";
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_update" });
    const outcome = await runWriteGate(
      { type: "learning", scope: "lint", content: REWRITE },
      { ...ctx(sid), hasGateCheck: true, supersedesTs: M1 },
    );
    expect(outcome.action).toBe("promoted");

    const lines = evidence();
    expect(ev(lines, "dedup_clean").length).toBe(1);
    expect(ev(lines, "write_promoted").length).toBe(1);
  });
});

describe("S4e — conflict-floor calibration and rival selection (PR #125 review)", () => {
  // The floors are calibrated constants, but S4c alone pins only "0.044 passes"
  // and "0.80 blocks": measured, mutating CONFLICT_OVERLAP_FLOOR 0.3 -> 0.26
  // passes the entire suite. The pairs below are constructed to EXACT jaccard
  // scores over the gates.ts tokenizer (no stopword filtering), so the suite
  // pins the claimed band end to end: the production false-block pair at 0.25
  // must store clean, rivalry starts at 0.30 INCLUSIVE, and the rephrase floor
  // for other types is inclusive at 0.90. Each pin kills a specific surviving
  // mutant; see the per-test notes.

  // |A|=12, |B|=13, shared 5 -> 5/20 = 0.25 exactly. Mirrors the real blocked
  // preference (chain f03c9f6e) that motivated the floor. Kills any floor
  // drift <= 0.25 (0.25 >= floor would block it).
  const Q25_SEED =
    "preference use code review sessions before risky auth billing handoffs pairwise async";
  const Q25_IN =
    "preference use code review before always squashing flaky tests twice ci green manually";

  // 5/19 = 0.2632: just above the claimed false-block, safely under the floor.
  const Q26_SEED =
    "preference use code review sessions before risky auth billing handoffs pairwise";
  const Q26_IN = Q25_IN;

  // 7/25 = 0.28: top of the coexistence band, 0.02 under the floor.
  const Q28_SEED =
    "preference keep unit tests next to source mirroring package module paths under src tree";
  const Q28_IN =
    "preference keep unit tests next to source code colocated inside the app everywhere forever plus legacy dirs hacks";

  // 6/20 = 0.3 exactly (and 6/20 >= 0.3 holds in IEEE doubles while 6/20 > 0.3
  // does NOT): pins floor INCLUSIVITY. Kills `score >= floor` -> `score > floor`.
  const F30_SEED =
    "preference write commit messages in summary present tense imperative voice subject line bullets";
  const F30_IN =
    "preference write commit messages in summary past narrative changelog style release notes backlog";

  async function runPreference(sid: string, scope: string, content: string) {
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    return runWriteGate({ type: "preference", scope, content }, { ...ctx(sid), hasGateCheck: true });
  }

  test("0.25-overlap second preference stores clean (production false-block claim)", async () => {
    seed("preference", "band25", Q25_SEED);
    const outcome = await runPreference("s4e-25", "band25", Q25_IN);
    expect(outcome.action).toBe("promoted");
    expect(ev(evidence(), "write_blocked").length).toBe(0);
  });

  test("0.26-overlap preference stores clean (lower band pin)", async () => {
    seed("preference", "band26", Q26_SEED);
    const outcome = await runPreference("s4e-26", "band26", Q26_IN);
    expect(outcome.action).toBe("promoted");
  });

  test("0.28-overlap preference stores clean (upper band pin)", async () => {
    seed("preference", "band28", Q28_SEED);
    const outcome = await runPreference("s4e-28", "band28", Q28_IN);
    expect(outcome.action).toBe("promoted");
  });

  test("0.30-overlap preference is review-gated — the conflict floor is inclusive", async () => {
    const M1 = seed("preference", "floor30", F30_SEED);
    const outcome = await runPreference("s4e-30", "floor30", F30_IN);
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("superseded_overlap");
    const lines = evidence();
    expect(field(ev(lines, "write_blocked")[0], "flags")).toBe(
      `[supersedes_check_${M1},score=0.3,review_gated]`,
    );
  });

  // ---- rival selection: BEST, not first-over-floor, not newest -------------
  // S4/S4c seed exactly one rival, so first == best == newest there and neither
  // "cite divergent[0]" nor "cite newest" (the pre-PR defects) is reachable.
  // These scopes pin all three orderings at once. Scores vs incoming:
  // HIGH 0.85, MID 0.44, LOW 0.09 (below the floor, never a rival).
  const MR_IN = "preference use prettier for formatting every javascript document in the docs tree";
  const MR_HIGH = "preference use prettier for formatting every typescript document in the docs tree";
  const MR_MID = "preference use prettier for formatting every yaml document plus json files";
  const MR_LOW = "preference rotate signing keys every ninety days via vault with audit logging";

  test("cites the best rival, not the first over the floor", async () => {
    // Scan order MID(0.44) -> HIGH(0.85): a first-over-floor implementation
    // would cite MID.
    const MID = seed("preference", "selbest", MR_MID, "2026-03-01T00:00:01.000Z");
    const HIGH = seed("preference", "selbest", MR_HIGH, "2026-03-01T00:00:02.000Z");
    seed("preference", "selbest", MR_LOW, "2026-03-01T00:00:03.000Z");
    const outcome = await runPreference("s4e-best", "selbest", MR_IN);
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("superseded_overlap");
    expect(outcome.hint).toContain(HIGH);
    expect(outcome.hint).not.toContain(MID);
    const lines = evidence();
    expect(field(ev(lines, "write_blocked")[0], "flags")).toBe(
      `[supersedes_check_${HIGH},score=0.85,review_gated]`,
    );
    expect(field(ev(lines, "dedup_overlap")[0], "candidate")).toBe(HIGH);
  });

  test("cites the best rival, not the newest row; merge_proposal canonical is still 'newest' (documented quirk)", async () => {
    // Scan order HIGH(0.85) -> LOW -> MID(0.44): newest row is MID, so a
    // "cite newest" implementation (the pre-PR flag bug) cites MID here.
    const HIGH = seed("preference", "selnewest", MR_HIGH, "2026-03-01T00:00:01.000Z");
    seed("preference", "selnewest", MR_LOW, "2026-03-01T00:00:02.000Z");
    const MID = seed("preference", "selnewest", MR_MID, "2026-03-01T00:00:03.000Z");
    const outcome = await runPreference("s4e-newest", "selnewest", MR_IN);
    expect(outcome.action).toBe("blocked");
    const lines = evidence();
    expect(field(ev(lines, "write_blocked")[0], "flags")).toBe(
      `[supersedes_check_${HIGH},score=0.85,review_gated]`,
    );
    // DOCUMENTED QUIRK: merge_proposal keeps canonical = newest-in-scope, which
    // is NOT the cited rival (candidate) and need not even be over the floor.
    // A fix that points canonical at the real rival must update this pin.
    const merge = ev(lines, "merge_proposal")[0];
    expect(field(merge, "candidate")).toBe(HIGH);
    expect(field(merge, "canonical")).toBe(MID);
    expect(field(merge, "review")).toBe("advisory");
    expect(field(merge, "incoming_stored")).toBe("false");
  });

  test("supersedesTs excludes ONLY the target — another live rival still blocks the update", async () => {
    // Guards the exclusion from growing into an update-wide gate-3 skip or an
    // "exclude everything similar to the target" rule.
    const T = seed("preference", "selexport", MR_LOW, "2026-03-01T00:00:01.000Z");
    const R2 = seed("preference", "selexport", MR_HIGH, "2026-03-01T00:00:02.000Z");
    setCurrent({ sessionID: "s4e-excl", callID: "C1", tool: "memory_update" });
    const outcome = await runWriteGate(
      { type: "preference", scope: "selexport", content: MR_IN },
      { ...ctx("s4e-excl"), hasGateCheck: true, supersedesTs: T },
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("superseded_overlap");
    expect(outcome.hint).toContain(R2);
    const lines = evidence();
    expect(field(ev(lines, "write_blocked")[0], "flags")).toBe(
      `[supersedes_check_${R2},score=0.85,review_gated]`,
    );
  });

  test("0.90-overlap learning rewording is review-gated (OVERLAP_FLOOR inclusive)", async () => {
    // 9/10, exactly 0.9 in IEEE doubles: pins `>=` for the non-conflict floor.
    const M1 = seed("learning", "rephrase", "the release train cuts tags from main every tuesday");
    setCurrent({ sessionID: "s4e-90", callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      { type: "learning", scope: "rephrase", content: "the release train cuts tags from main every tuesday morning" },
      { ...ctx("s4e-90"), hasGateCheck: true },
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("superseded_overlap");
    expect(field(ev(evidence(), "write_blocked")[0], "flags")).toBe(
      `[supersedes_check_${M1},score=0.9,review_gated]`,
    );
  });

  test("0.87-overlap learning rewording stores clean (just under the rephrase floor)", async () => {
    // 13/15 = 0.8667: kills OVERLAP_FLOOR drift below ~0.87.
    seed("learning", "rephrase87", "the deploy checklist drains connections stops workers flips dns verifies health endpoints staging status");
    setCurrent({ sessionID: "s4e-87", callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      {
        type: "learning",
        scope: "rephrase87",
        content: "the deploy checklist drains connections stops workers flips dns verifies health endpoints staging traffic",
      },
      { ...ctx("s4e-87"), hasGateCheck: true },
    );
    expect(outcome.action).toBe("promoted");
  });
});

describe("S-edge — incoming-stale write (poisoning guard)", () => {
  test("drift before dedup; block the stale incoming; neutralize the twin", async () => {
    writeFileSync(
      join(liveRoot, "table_manager.ts"),
      "export function save(config, opts) {\n  return [config, opts];\n}\n",
    );
    const M1 = seed("pattern", "ctl", "use table_manager.save(opts)");
    const sid = "s-edge";
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });

    const outcome = await runWriteGate(
      { type: "pattern", scope: "ctl", content: "use table_manager.save(opts)" },
      ctx(sid),
    );
    expect(outcome.action).toBe("blocked");
    expect(outcome.reason).toBe("drift_ref_stale_incoming");

    const lines = evidence();
    assertOrder(lines, [
      "gate_start",
      "graph_drift",
      "ref_stale_scan",
      "ref_stale",
      "superseded_by",
      "dedup_collapse",
      "write_blocked",
    ]);
    const gd = ev(lines, "graph_drift")[0];
    expect(field(gd, "from")).toBe("save(opts)");
    expect(field(gd, "to")).toBe("save(config, opts)");
    const sb = ev(lines, "superseded_by")[0];
    expect(field(sb, "target")).toBe("<-");
    expect(field(sb, "reason")).toBe("drift");
    expect(ev(lines, "write_promoted").length).toBe(0);
    expect(field(ev(lines, "write_blocked")[0], "reason")).toBe("drift_ref_stale_incoming");
    const durable = await loadAll();
    expect(durable.find((m) => m.ts === M1)?.superseded_by).toBeTruthy();
    expect(durable.length).toBe(1);
  });
});

describe("S5 — prune-a-bad-memory (Principle 3)", () => {
  test("deletes with reason, snapshots for rollback, audits, never repo-touching", async () => {
    const T1 = seed("pattern", "testing", "always run vitest before playwright");
    const before = readFileSync(join(memoryRoot(), `${T1.split("T")[0]}.logfmt`), "utf8");
    mkdirSync(snapshotDir(), { recursive: true });

    const res = await pruneMemory("testing", "pattern", "playwright now gates CI first");
    expect(res.deleted.length).toBe(1);

    const lines = evidence();
    const prune = ev(lines, "prune")[0];
    expect(field(prune, "mem")).toBe(T1);
    expect(field(prune, "reason")).toBe("playwright now gates CI first");
    expect(field(prune, "tool")).toBe("memory_forget");
    expect(field(prune, "audit")).toContain(memoryRoot());

    expect((await loadAll()).length).toBe(0);
    const audit = readFileSync(join(memoryRoot(), "deletions.logfmt"), "utf8");
    expect(audit).toContain("playwright now gates CI first");

    expect(res.snapshot).toHaveLength(1);
    expect(readFileSync(res.snapshot[0], "utf8")).toBe(before);
    expect(res.snapshot[0]).toContain(memoryRoot());
    expect(res.snapshot[0]).not.toContain(liveRoot);
  });

  test("a forget that matches nothing writes no snapshot and no deletion", async () => {
    seed("pattern", "testing", "always run vitest before playwright");
    mkdirSync(snapshotDir(), { recursive: true });

    const res = await pruneMemory("nothing-matches-this", "pattern", "cleanup sweep");
    expect(res.deleted.length).toBe(0);
    // Contract: snapshots are taken per REWRITTEN file, not per file that
    // exists — a no-op forget must not mint an undo point for nothing.
    expect(res.snapshot).toEqual([]);
    expect((await loadAll()).length).toBe(1);
    expect(existsSync(join(memoryRoot(), "deletions.logfmt"))).toBe(false);
  });
});

describe("S6 — FAIL→PASS gate → learning (T4)", () => {
  test("t4_learning with the real call chain and the edit as fix_ref", async () => {
    const sid = "s6";
    await call(sid, "C1", "bash", { command: "npx vitest run" }, "FAIL: save expects 2 args", {
      exitCode: 1,
    });
    await call(sid, "C2", "grep", { pattern: "save" }, "3 matches found");
    await call(sid, "C3", "read", { filePath: "x.ts" }, "content");
    await call(sid, "C4", "edit", { filePath: "x.ts" }, "edit ok");
    await call(sid, "C5", "bash", { command: "npx vitest run" }, "PASS", { exitCode: 0 });

    const lines = evidence();
    assertOrder(lines, ["gate_check", "tool_result", "tool_result", "tool_result", "gate_check", "t4_learning"]);
    const t4 = ev(lines, "t4_learning")[0];
    expect(field(t4, "gate_couple")).toBe("true");
    expect(field(t4, "evidence_chain")).toBe("[C1,C2,C3,C4,C5]");
    expect(field(t4, "fix_ref")).toBe("C4");
    expect(field(t4, "from")).toBe("FAIL");
    expect(field(t4, "to")).toBe("PASS");
    for (const line of ev(lines, "t4_learning")) {
      expect(field(line, "gate_couple")).toBe("true");
    }
  });
});

describe("I3 — evidence never injected", () => {
  test("digest is tiny and free of evidence; contextual pull only returns durable memory", async () => {
    seed("pattern", "ctl", "use table_manager.save(config, opts)");

    const system: string[] = [];
    await systemDigest({}, { system });
    const digest = system.join("\n");
    expect(digest).not.toContain("evidence");
    expect(digest).not.toContain("logfmt");
    expect(digest.split("\n").filter((l) => l.trim()).length).toBeLessThanOrEqual(3);

    const output = { output: "grep results" };
    await contextualPull(
      { tool: "grep", args: { pattern: "table_manager.save" } },
      output,
    );
    expect(output.output).toContain("use table_manager.save(config, opts)");
    expect(output.output).not.toContain("ev=");
  });
});
