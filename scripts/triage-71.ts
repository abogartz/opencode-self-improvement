// Rebuild #71's per-test ledger from two COMPLETE sweep logs. Final mutant
// verdicts matter: an unconfirmed timing failure is not a kill witness.
// Usage: bun scripts/triage-71.ts before.jsonl after.jsonl [output.json]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Event = { mutant: string; phase?: string; status?: string; tests?: string[]; skipped?: string[]; delta?: string[] };
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [beforePath, afterPath, output = join(root, "bench/test-integrity-71.json")] = Bun.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("usage: bun scripts/triage-71.ts before.jsonl after.jsonl [output.json]");

function readSweep(path: string) {
  const events: Event[] = readFileSync(path, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const bases = events.filter((event) => event.mutant === "baseline");
  if (bases.length !== 1 || !bases[0].tests?.length || bases[0].delta?.length) {
    throw new Error(`${path}: expected one green baseline with test identifiers`);
  }
  const results = events.filter((event) => event.phase === "result");
  if (results.length !== 44 || new Set(results.map((event) => event.mutant)).size !== 44) {
    throw new Error(`${path}: expected 44 distinct final verdicts; the log is incomplete or contains multiple sweeps`);
  }
  const statuses = new Set(["killed", "survived", "timeout", "runtime-error", "compile-error", "equivalent"]);
  if (results.some((event) => !event.status || !statuses.has(event.status))) throw new Error(`${path}: missing or unknown final status`);
  const tests = new Set(bases[0].tests);
  const skipped = new Set(bases[0].skipped ?? []);
  const kills = new Map<string, string[]>();
  for (const event of results) {
    if (event.status !== "killed") continue;
    for (const name of event.delta ?? []) {
      if (!tests.has(name)) throw new Error(`${path}: kill witness absent from passing baseline: ${name}`);
      kills.set(name, [...(kills.get(name) ?? []), event.mutant].sort());
    }
  }
  return { tests, skipped, kills, results: results.sort((a, b) => a.mutant.localeCompare(b.mutant)) };
}

const before = readSweep(beforePath);
const after = readSweep(afterPath);
if (before.results.some((event, i) => event.mutant !== after.results[i].mutant)) throw new Error("different mutant catalogs");
const reasons: Record<string, string> = JSON.parse(readFileSync(join(root, "bench/test-integrity-71-verdicts.json"), "utf8"));
const files = readdirSync(join(root, "test")).filter((file) => file.endsWith(".test.ts")).sort();
if (files.some((file) => !reasons[file]) || Object.keys(reasons).some((file) => !files.includes(file))) throw new Error("every current test file needs exactly one verdict");
const oldCommand = "command.test.ts > ensureInitCommand > missing source degrades silently (no throw on load)";
const newCommand = "command.test.ts > ensureInitCommand > a missing command source returns null and writes no command";
const strengthened = new Set([
  newCommand,
  "compaction.test.ts > memory-aware compaction anchor > anchor is capped at 2500 chars and never cut mid-line",
  "concurrency.test.ts > supersede racing appends > a concurrent reader never sees a half-written file",
  "epoch.test.ts > epoch freeze (cache-safe injection) > case 4: budget cap — block <= budget chars, whole lines only, extras dropped",
  "plugin.test.ts > plugin wiring (OpenCode V2) > session.context pushes the memory digest as a system text part",
  "repokey-path.test.ts > non-git repo keys are bare tokens (#92) > the path hash is stable across spelling: separators, trailing slash, case, aliases",
  "repokey-path.test.ts > non-git repo keys are bare tokens (#92) > normalizeDirPath returns a separator-unified, trailing-slash-free path",
  "scenarios.test.ts > S5 — prune-a-bad-memory (Principle 3) > deletes with reason, snapshots for rollback, audits, never repo-touching",
  "status.test.ts > memory_status tool + epoch wiring > injections count at the decision; message.updated lands measured + flush",
  "temp-root.test.ts > requireTempPath > accepts a path under the system temp dir, whatever the separator",
]);
const names = [...new Set([...after.tests, ...after.skipped])].sort();
for (const name of strengthened) if (!after.tests.has(name)) throw new Error(`strengthened test missing from candidate baseline: ${name}`);
const records = names.map((name) => {
  const previous = name === newCommand ? oldCommand : name;
  if (!before.tests.has(previous) && !before.skipped.has(previous)) throw new Error(`unaccounted new test: ${name}`);
  const file = name.split(" > ")[0];
  if (!reasons[file]) throw new Error(`unknown test file: ${file}`);
  return {
    test: name,
    ...(name !== previous ? { previousName: previous } : {}),
    baseline: before.skipped.has(previous) ? "skipped" : "passed",
    candidate: after.skipped.has(name) ? "skipped" : "passed",
    beforeKills: before.kills.get(previous) ?? [],
    afterKills: after.kills.get(name) ?? [],
    decision: strengthened.has(name) ? "strengthened" : "kept-with-file-reason",
  };
});
for (const name of [...before.tests, ...before.skipped]) {
  if (!names.includes(name === oldCommand ? newCommand : name)) throw new Error(`unaccounted removed test: ${name}`);
}
const mutants = before.results.map((event, i) => ({ mutant: event.mutant, before: event.status, after: after.results[i].status }));
const regressions = mutants.filter((event) => event.before === "killed" && event.after !== "killed");
const summary = (sweep: ReturnType<typeof readSweep>) => ({
  passingIdentifiers: sweep.tests.size, skippedIdentifiers: sweep.skipped.size,
  observedKillers: sweep.kills.size, passingWithoutObservedKill: sweep.tests.size - sweep.kills.size,
  killedMutants: sweep.results.filter((event) => event.status === "killed").length,
  statuses: Object.fromEntries([...new Set(sweep.results.map((event) => event.status ?? "unknown"))].sort().map((status) => [status, sweep.results.filter((event) => event.status === status).length])),
});
const data = {
  issue: "https://github.com/abogartz/opencode-self-improvement/issues/71",
  sourceBase: "525ed89", instrumentedBaseline: "8f97437", candidateTests: "96b7d3d",
  platform: "Windows x64", bun: "1.4.4", catalogSize: 44,
  commands: ["bun scripts/test-sweep.ts --selftest --timeout=120", "bun scripts/test-sweep.ts --jobs=2 --timeout=120 --log=before.jsonl", "bun scripts/test-sweep.ts --jobs=4 --timeout=180 --log=after.jsonl", "bun scripts/triage-71.ts before.jsonl after.jsonl"],
  interpretation: "Observed failures on killed mutants, not proof that every failure was causal or that unobserved tests are redundant. Timing-only mutant kills use the sweep's confirmation policy. These are unique printed test identifiers; equal parameterized titles would be grouped. Skips are separate, never no-kill candidates. Nine additional assertion probes are outside this 44-mutant score. E2E tests run in the merge gate, not this mutation sweep.",
  capabilityCaveat: "Some filesystem permission tests return early when chmod/ACL prerequisites are unavailable. Bun reports those as passed, unlike declared skips. The ledger records runner outcomes, not proof of branch execution; see the containment and lock file verdicts.",
  survivorInterpretation: {
    "lock-restore-failopen": "The tests pin explicit fail policy at the lock seam, but do not force restore's LOCK_RESTORE configuration through its busy timeout. Needs a deterministic policy witness.",
    "supersede-rmw-nolock": "Conservation scenarios do not guarantee the losing read-modify-write interleave. A surviving run is not evidence that the lock is unnecessary.",
    "snapshot-overwrite": "The catalog removes exclusive snapshot creation; a test must force a name collision to observe overwriting rather than relying on millisecond coincidence.",
    "viewer-snapshot-grammar-off": "The backend resolveSnapshot also rejects names outside the same anchored grammar. This survivor may reflect a redundant validation layer rather than missing containment. Kept in the original denominator here; audit equivalence separately before reclassifying it.",
    "restore-escapes-root": "resolveSnapshot derives the target basename from a date-only grammar before this lexical root check. The symlink checks remain intact. This is another possible redundant guard, not evidence of a reachable escape; retain its original classification pending a separate equivalence review.",
  },
  baseline: summary(before), candidate: summary(after), regressions, mutants, files: reasons, tests: records,
};
// One test per line keeps the checked-in evidence navigable without dropping
// individual test identities or collapsing decisions to a file-only tally.
const header = JSON.stringify({ ...data, tests: undefined }, null, 2).replace(/\n}$/, ',\n  "tests": [\n');
writeFileSync(output, `${header}${records.map((record) => `    ${JSON.stringify(record)}`).join(",\n")}\n  ]\n}\n`);
console.log(JSON.stringify({ output: basename(output), baseline: data.baseline, candidate: data.candidate, regressions }, null, 2));
console.log("\n| File | Passing | Killers before / after | Verdict |\n| --- | ---: | ---: | --- |");
for (const file of files) {
  const rows = records.filter((row) => row.test.startsWith(`${file} > `));
  console.log(`| ${file} | ${rows.filter((row) => row.candidate === "passed").length} | ${rows.filter((row) => row.beforeKills.length).length} / ${rows.filter((row) => row.afterKills.length).length} | ${reasons[file]} |`);
}
if (regressions.length) process.exitCode = 1;
