#!/usr/bin/env bun
// Mutation sweep - the auditor of the scenario suite (issue #70, epic #68).
//
// One question: when an invariant dies, does anything die with it? Each mutant
// breaks exactly ONE claimed invariant in a detached `git worktree` of HEAD,
// runs the unit+scenario suite against that tree, and reports whether the
// suite noticed. A mutant nothing kills is an unpinned invariant, whatever the
// test titles claim. The sweep audits the tests; it is not a score to chase:
// every mutant here mirrors a named invariant, and some are expected to
// survive - those become entries on the unpinned list, not red CI.
//
// Isolation: mutants are applied ONLY to scratch worktrees created from HEAD
// (never the checkout under your feet); scratch trees get a node_modules
// junction and are `git checkout -- .` reset between runs.
//
// Honesty rules this tool implements (all from #68/#70):
//  - Baseline first. The clean tree's failing-test set is computed up front
//    and subtracted from every mutant run: only DELTA failures count as kills.
//    The Windows torn-read/EPERM family (lock-file sharing violations and
//    rename-EPERM under concurrent readers) fails 0-2 tests per run, load
//    dependent; a flake must never masquerade as a kill.
//  - A mutant whose only kill evidence comes from timing-sensitive tests gets
//    rerun (up to --confirm=3 total runs) and is only killed if every run
//    kills. An unstable kill is a D2 (race-and-hope), reported as such.
//  - Statuses: killed / survived / timeout / runtime-error / compile-error /
//    equivalent. A CompileError (or a mutant that breaks module loading) is
//    informational, never a kill. Equivalent mutants carry a written
//    justification and are excluded from the canonical score's denominator.
//  - A run that did not finish the suite (interrupted spawn, a stranded test
//    child interfering) is classified runtime-error - never a silent survive -
//    and gets one retry on a rebuilt scratch. Scratch trees self-heal between
//    runs (#70 observed a tracked source file go missing between mutants).
//  - The instrument must be able to fail: --selftest plants a mutation in a
//    trivially-tested pure function and exits nonzero if the suite does NOT
//    kill it. A measurement that cannot fail is itself a defect (#68).
//
// Usage:
//   bun run scripts/test-sweep.ts --validate           # pattern sites only, no test runs
//   bun run scripts/test-sweep.ts --selftest           # calibration: planted mutant MUST die
//   bun run scripts/test-sweep.ts                      # baseline + all mutants, --repeat=1
//   bun run scripts/test-sweep.ts --repeat=3           # 3 suite runs per mutant
//   bun run scripts/test-sweep.ts --mutant=undo-force-safety-removed[,id...]
//   bun run scripts/test-sweep.ts --list               # print the mutant table and exit
// Options: --jobs=N (parallel scratch worktrees; default 1 - the suite is
// disk/CPU-bound and parallel wall-clock is reported honestly), --timeout=SEC
// (per suite run, default 600), --bun=PATH (bun used to run the suite),
// --baseline (baseline run only), --confirm=N (reruns for flaky-only kills,
// default 3), --keep (keep scratch worktrees), --allow-baseline-failures
// (sweep anyway when the baseline tree is red outside the known family),
// --fail-on-survivors (exit 4 when anything survives - #72 pre-release gate),
// --log=PATH (JSONL event log).
import { existsSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { testOutcomes } from "./sweep-output.ts";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
// Siblings of the checkout, never inside it.
const SCRATCH_ROOT = join(REPO, "..", `sweep-scratch-${basename(REPO)}`);

// ---------------------------------------------------------------------------
// The mutant set. One entry per claimed invariant - never a generic operator
// sweep (#70: "a mutant nobody would have thought to write is a story about
// my imagination"). `find` is ONE contiguous region and must match EXACTLY
// once (--validate enforces); multi-line regions are given as joined lines.
// class: D1 wrong seam, D2 unreached window, D3 pass-for-wrong-reason,
//        D4 no conservation, guard/pure: named guard at its honest level.
// ---------------------------------------------------------------------------

const L = (...lines: string[]): string => lines.join("\n");

interface Mutant {
  id: string;
  /** source file, repo-relative */
  file: string;
  /** exact text to find; must occur exactly once */
  find: string;
  /** replacement applied in its place */
  replace: string;
  /** the invariant this mutation breaks, in one line */
  invariant: string;
  class: "D1" | "D2" | "D3" | "D4" | "guard" | "pure";
  /** true when a scenario in test/scenarios* is the net expected to kill it */
  scenario?: boolean;
  /** survived-by-design, with the written justification (#70 status class) */
  equivalent?: string;
}

// Source fragments with characters that must survive the parser exactly:
// em dashes are escaped (String.raw would be a trap here), regex sources are
// written as they appear in the source text.
const SNAPSHOT_GRAMMAR = "^\\d+-\\d{4}-\\d{2}-\\d{2}\\.logfmt$";
const QUOTE_CLASS = "[\\s\"=]";
const QUOTE_CLASS_PLAIN = "[\"=]";

export const MUTANTS: Mutant[] = [
	// ---- store lock (src/lock.ts) -------------------------------------------
	{
		id: "lock-noexcl-mutex",
		file: "src/lock.ts",
		find: `const handle = await open(lockPath, "wx");`,
		replace: `const handle = await open(lockPath, "w");`,
		invariant: "lock file is created with O_EXCL: the mutex is cross-process",
		class: "D2",
		scenario: true, // consistency: two sessions rewriting one day file
	},
	{
		id: "lock-no-stale-steal",
		file: "src/lock.ts",
		find: `if (age < STALE_MS) return false;`,
		replace: `if (age >= 0) return false;`,
		invariant: "a lock abandoned by a dead process is taken over after age",
		class: "guard",
	},
	{
		id: "lock-restore-failopen",
		file: "src/lock.ts",
		find: L(`export const LOCK_RESTORE: LockOptions = {`, `  onTimeout: "fail",`),
		replace: L(`export const LOCK_RESTORE: LockOptions = {`, `  onTimeout: "proceed",`),
		invariant: "restore fails CLOSED on a busy store, because force drops rows",
		class: "D2",
	},
	// ---- atomic publish / handover (src/logfmt.ts) ---------------------------
	{
		id: "publish-rename-to-truncate",
		file: "src/logfmt.ts",
		// Re-anchored 2026-10-26: #89 moved the rename into handoverRename;
		// the publish as it now stands still means hand-over-by-rename, so the
		// mutation keeps its meaning - collapse the write+handover pair into a
		// truncating write straight onto the destination.
		find: L(`    await Bun.write(tmp, content);`, `    await handoverRename(tmp, file, since);`),
		replace: `    await Bun.write(file, content);`,
		invariant: "whole-file publishes hand over by rename: readers (no lock)",
		class: "D2", // never observe the truncated middle
	},
	{
		id: "publish-rename-since-blind",
		file: "src/logfmt.ts",
		// #110 companion (the ruling's "pin-first" follow-up): the anchored
		// retry renames only while the destination still matches `since`. Blind
		// it and a contention-blocked writer keeps retrying past a mid-window
		// touch - a slow way of publishing stale bytes over the row the
		// immediate failure preserved. The pre-existing pins kill it only by
		// racing the release timer against the 2s deadline (1.33x margin); the
		// third handover test verdicts it in ~450ms, 4x inside - that is the
		// kill this catalog entry leans on.
		find: `      if ((await fileIdentity(file)) !== since) throw err; // destination moved; our copy is stale`,
		replace: `      if (false) throw err; // MUTANT: since-gate off, retry blind`,
		invariant: "anchored retry re-checks the destination before renaming: a premise that moved aborts",
		class: "D2", // an unlocked writer's mid-window row survives an anchored publish
	},
	{
		id: "append-truncate-regression",
		file: "src/logfmt.ts",
		find: `await appendFile(file, next);`,
		replace: `await Bun.write(file, next);`,
		invariant: "appends are one O_APPEND write, never a replacing write",
		class: "D2",
	},
	// ---- store write paths (src/memory.ts) -----------------------------------
	{
		id: "append-nolock",
		file: "src/memory.ts",
		find: `return withStoreLock(file, async () => {`,
		replace: `return ((...a: unknown[]) => (a[1] as () => Promise<unknown>)())(file, async () => {`,
		invariant: "appends hold the store lock: none lands inside an RMW window",
		class: "D2",
		scenario: true,
	},
	{
		id: "supersede-rmw-nolock",
		file: "src/memory.ts",
		find: L(`  return withStoreLock(`, `    file,`, `    async () => {`),
		replace: L(
			`  return ((...a: unknown[]) => (a[1] as () => Promise<unknown>)())(`,
			`    file,`,
			`    async () => {`,
		),
		invariant: "supersede is a locked read-modify-write (stampRow)",
		class: "D2",
		scenario: true, // consistency: two sessions rewriting one day file
	},
	{
		id: "prune-nolock",
		file: "src/memory.ts",
		find: L(`    await withStoreLock(`, `      file,`),
		replace: L(
			`    await ((...a: unknown[]) => (a[1] as () => Promise<unknown>)())(`,
			`      file,`,
		),
		invariant: "prune filters and republishes under the store lock",
		class: "D2",
		scenario: true, // consistency: prune sweep vs appending sessions
	},
	{
		id: "prune-repofloor-off",
		file: "src/memory.ts",
		find: `if (m && m.scope === scope && m.type === type && isVisibleTo(m, reader)) {`,
		replace: `if (m && m.scope === scope && m.type === type) {`,
		invariant: "forget never deletes another repo's row for the same scope",
		class: "guard",
	},
	{
		id: "blocklist-poison-filter-off",
		file: "src/memory.ts",
		find: `if (m && !blocked.has(m.ts)) out.push(m);`,
		replace: `if (m) out.push(m);`,
		invariant: "blocked (poisoned) rows are filtered from every read path",
		class: "guard",
	},
	{
		id: "malformed-ts-guard-and",
		file: "src/memory.ts",
		find: `if (!ISO_TS_RE.test(ts) || Number.isNaN(Date.parse(ts))) {`,
		replace: `if (!ISO_TS_RE.test(ts) && Number.isNaN(Date.parse(ts))) {`,
		invariant: "a non-ISO ts is malformed: skipped, never an addressable row",
		class: "guard",
	},
	{
		id: "redact-chokepoint-off",
		file: "src/memory.ts",
		find: `const content = redactSecrets(input.content);`,
		replace: `const content = input.content;`,
		invariant: "secrets are redacted at the single write choke point",
		class: "guard",
	},
	{
		id: "metadata-secret-guard-off",
		file: "src/memory.ts",
		find: `if (credentialMetadata.length) {`,
		replace: `if (false && credentialMetadata.length) {`,
		invariant: "credential-shaped metadata is refused, not stored",
		class: "guard",
	},
	{
		id: "snapshot-overwrite",
		file: "src/memory.ts",
		find: `const handle = await open(snap, "wx");`,
		replace: `const handle = await open(snap, "w");`,
		invariant: "claimSnapshot bumps names with O_EXCL: a snapshot is never",
		class: "D4", // overwritten, across processes and not just in one
	},
	{
		id: "visible-global-off",
		file: "src/memory.ts",
		find: `if (!m.repo || m.repo === "global") return true;`,
		replace: `if (!m.repo) return true;`,
		invariant: "repo visibility: explicitly-global rows stay visible everywhere",
		class: "guard",
	},
	// ---- snapshot-then-restore pairing (src/undo.ts) --------------------------
	{
		id: "undo-force-safety-removed",
		file: "src/undo.ts",
		find: `const safety = mode === "force" ? (await snapshotFiles([target]))[0] : undefined;`,
		replace: `const safety: string | undefined = undefined;`,
		invariant: "force-restore snapshots what it drops, inside the lock:",
		class: "D4", // the pair - a dropped row must never be in neither place
		scenario: true, // scripted: a force restore between two remembers
	},
	{
		id: "undo-force-safety-after-publish",
		file: "src/undo.ts",
		find: L(
			"      const safety = mode === \"force\" ? (await snapshotFiles([target]))[0] : undefined;",
			"",
			"      let out = snapLines;",
			"      if (mode === \"merge\") {",
			"        // Keep the CURRENT version of rows the snapshot also has (in-place edits —",
			"        // e.g. a supersede stamp — made after the snapshot win), then append the",
			"        // rows the snapshot never saw. Merge is a deliberate superset: rows the",
			"        // snapshotter wrote after the snapshot are NOT dropped here; choose FORCE",
			"        // for that.",
			"        out = snapLines.map((l) => curByKey.get(rowKey(l)) ?? l).concat(",
			"          curOwn.filter((l) => !snapByKey.has(rowKey(l))),",
			"        );",
			"      }",
			"      // FORCE's \"exact rollback\" is exact FOR THE CALLER'S REPOSITORY, not",
			"      // beyond it: foreign live lines rejoin the file verbatim in every mode,",
			"      // appended at the end — line content preserved, position not (#153).",
			"      // Under the admin reader curForeign is empty and the write is the",
			"      // historical whole-file restore, byte for byte.",
			"      out = out.concat(curForeign);",
			"      await ensureDir(memoryRootDir);",
			"      await writeAtomic(target, out.length ? out.join(\"\\n\") + \"\\n\" : \"\", since);",
			"      return {",
			"        target,",
			"        restored: true,",
			"        mode,",
			"        safety,",
			"        concurrentAdded,",
			"        concurrentChanged,",
			"        deletedOmitted,",
			"        foreignPreserved: curForeign.length,",
			"      };",
		),
		replace: L(
			"      let safety: string | undefined;",
			"",
			"      let out = snapLines;",
			"      if (mode === \"merge\") {",
			"        // Keep the CURRENT version of rows the snapshot also has (in-place edits —",
			"        // e.g. a supersede stamp — made after the snapshot win), then append the",
			"        // rows the snapshot never saw. Merge is a deliberate superset: rows the",
			"        // snapshotter wrote after the snapshot are NOT dropped here; choose FORCE",
			"        // for that.",
			"        out = snapLines.map((l) => curByKey.get(rowKey(l)) ?? l).concat(",
			"          curOwn.filter((l) => !snapByKey.has(rowKey(l))),",
			"        );",
			"      }",
			"      // FORCE's \"exact rollback\" is exact FOR THE CALLER'S REPOSITORY, not",
			"      // beyond it: foreign live lines rejoin the file verbatim in every mode,",
			"      // appended at the end — line content preserved, position not (#153).",
			"      // Under the admin reader curForeign is empty and the write is the",
			"      // historical whole-file restore, byte for byte.",
			"      out = out.concat(curForeign);",
			"      await ensureDir(memoryRootDir);",
			"      await writeAtomic(target, out.length ? out.join(\"\\n\") + \"\\n\" : \"\", since);",
			"      safety = mode === \"force\" ? (await snapshotFiles([target]))[0] : undefined;",
			"      return {",
			"        target,",
			"        restored: true,",
			"        mode,",
			"        safety,",
			"        concurrentAdded,",
			"        concurrentChanged,",
			"        deletedOmitted,",
			"        foreignPreserved: curForeign.length,",
			"      };",
		),
		invariant: "the safety copy is taken BEFORE the publish that drops rows",
		class: "D4",
		scenario: true, // conservation-order flip: result.safety exists, is a lie
	},
	{
		id: "undo-check-mutates",
		file: "src/undo.ts",
		find: `if (mode === "check" && (concurrentAdded.length || concurrentChanged.length)) {`,
		replace: `if (mode === "check" && (concurrentAdded.length || concurrentChanged.length) && false) {`,
		invariant: "check mode never writes: a diverged store is refused, untouched",
		class: "D1",
	},
	{
		id: "undo-escapes-root-branch",
		file: "src/undo.ts",
		find: `if (!isWithin(snapshotsResolved, requestedResolved)) {`,
		replace: `if (false && !isWithin(snapshotsResolved, requestedResolved)) {`,
		invariant: "containment: the requested snapshot path stays in snapshots/",
		class: "D3",
		// formerly marked equivalent ("dead branch, probed in #70") — the sweep
		// disproved that: undo.test.ts kills it. The #70 finding-3 probe missed
		// a hostile-name shape that survives the realpath pre-check.
	},
	// ---- injection budget trimming (src/inject.ts) -----------------------------
	{
		id: "budget-overlong-breaks-scan",
		file: "src/inject.ts",
		find: `if (len + line.length + 1 > budget) continue; // skip over-long lines, keep scanning`,
		replace: `if (len + line.length + 1 > budget) break; // skip over-long lines, keep scanning`,
		invariant: "capToBudget skips over-long lines and keeps scanning the rest",
		class: "pure",
	},
	{
		id: "budget-dangling-header",
		file: "src/inject.ts",
		find: `if (kept.every((l) => l.startsWith("## "))) return "";`,
		replace: `if (false && kept.every((l) => l.startsWith("## "))) return "";`,
		invariant: "a block trimmed down to headers is dropped, never injected",
		class: "pure",
	},
	{
		id: "budget-header-fit-boundary",
		file: "src/inject.ts",
		find: `if (lines[0].length > budget) return "";`,
		replace: `if (lines[0].length >= budget) return "";`,
		invariant: "a header exactly the size of the budget still counts as fitting",
		class: "pure",
		equivalent:
			"when the header alone fills the budget, no content line can fit either way, and the dangling-header guard below returns \"\" for both builds: observable block content is identical for every (block, budget). An off-by-one at an unobservable boundary; pinning it would only pin the \">\" token, not a behavior.",
	},
	// ---- repo identity (src/repokey.ts) ----------------------------------------
	{
		id: "repokey-colon-form",
		file: "src/repokey.ts",
		find: `u = u.replace(":", "/");`,
		replace: `u = u.replace(":", "-");`,
		invariant: "every transport form of one remote hashes to one repo key",
		class: "pure",
	},
	// ---- viewer boundary (src/viewer/server.ts) ---------------------------------
	{
		id: "viewer-snapshot-grammar-off",
		file: "src/viewer/server.ts",
		find: `if (!/` + SNAPSHOT_GRAMMAR + `/.test(name)) {`,
		replace: `if (false && !/` + SNAPSHOT_GRAMMAR + `/.test(name)) {`,
		invariant: "restore names are pinned to the snapshot grammar at the wire",
		class: "D3", // gate-bypass: files planted inside snapshots/ - #70 finding 2
	},
	{
		id: "viewer-host-guard-off",
		file: "src/viewer/server.ts",
		find: `if (!allowedHostnames().has(url.hostname) || (url.port || "80") !== String(port)) {`,
		replace: `if (false && (!allowedHostnames().has(url.hostname) || (url.port || "80") !== String(port))) {`,
		invariant: "the loopback viewer rejects foreign Host headers (DNS rebinding)",
		class: "guard",
	},
	{
		id: "viewer-content-type-off",
		file: "src/viewer/server.ts",
		find: `if (type !== "application/json") return error("content-type must be application/json", 415);`,
		replace: `if (false && type !== "application/json") return error("content-type must be application/json", 415);`,
		invariant: "writes must be application/json (cross-site form refusal)",
		class: "guard",
	},
	// ---- ported from the original sweep tool (6d1858b) ------------------------
	// Those mutants stay under their original ids. Five of that tool's entries
	// were deduped here because they break the same site the same way an
	// existing id already breaks: lock-never-steal, publish-truncate,
	// blocklist-visible, restore-check-blind, restore-safety-stale.
	{
		id: "lock-noop",
		file: "src/lock.ts",
		find: `  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;`,
		replace: `  return fn();\n  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;`,
		invariant: "whole-file rewrites are serialized per store file",
		class: "D2",
		scenario: true,
	},
	{
		id: "lock-release-blind",
		file: "src/lock.ts",
		find: `      if ((await Bun.file(lockPath).text()) === token) await unlink(lockPath);`,
		replace: `      await unlink(lockPath);`,
		invariant: "a holder never deletes a lock another process took over",
		class: "D2",
	},
	{
		// The main lock had this policy branch duplicated (direct budget path +
		// queue-abandon path); the original single mutant went ambiguous when
		// both landed. Split into two uniquely-anchored mutants.
		id: "lock-default-fail",
		file: "src/lock.ts",
		// Re-anchored 2026-10-26: the #107 branch threaded the `now()` seam
		// through the wait loop, and --validate caught this anchor rot on the
		// same day it landed (#110's validate earned its keep immediately).
		// Meaning unchanged: the fail-vs-proceed choice at timeout is forced
		// to fail for every caller.
		find: L(
			`      if (now() - started >= budgetMs) {`,
			`        opts.onEvent?.("timeout", now() - started);`,
			`        if (opts.onTimeout === "fail") {`,
		),
		replace: L(
			`      if (now() - started >= budgetMs) {`,
			`        opts.onEvent?.("timeout", now() - started);`,
			`        if (true) {`,
		),
		invariant: "an ordinary write proceeds rather than losing the write",
		class: "D1",
	},
	{
		id: "lock-default-fail-queued",
		file: "src/lock.ts",
		find: L(
			`      finish();`,
			`      opts.onEvent?.("timeout", Date.now() - started);`,
			`      if (opts.onTimeout === "fail") {`,
		),
		replace: L(
			`      finish();`,
			`      opts.onEvent?.("timeout", Date.now() - started);`,
			`      if (true) {`,
		),
		invariant: "a queued ordinary write proceeds rather than losing the write",
		class: "D1",
	},
	{
		id: "restore-merge-drops",
		file: "src/undo.ts",
		find: L(
			`        out = snapLines.map((l) => curByKey.get(rowKey(l)) ?? l).concat(`,
			`          curOwn.filter((l) => !snapByKey.has(rowKey(l))),`,
			`        );`,
		),
		replace: `        out = snapLines;`,
		invariant: "merge restores the snapshot AND keeps concurrently written rows",
		class: "D4",
		scenario: true,
	},
	{
		id: "restore-escapes-root",
		file: "src/undo.ts",
		find: `  if (!isWithin(rootReal, realTarget)) {`,
		replace: `  if (false && !isWithin(rootReal, realTarget)) {`,
		invariant: "a restore cannot write outside the memory root",
		class: "D3",
	},
	{
		id: "row-ts-any",
		file: "src/memory.ts",
		find: `  if (!ISO_TS_RE.test(ts) || Number.isNaN(Date.parse(ts))) {`,
		replace: `  if (false) {`,
		invariant: "a row whose ts is not an ISO instant is not addressable",
		class: "guard",
	},
	{
		id: "repo-floor-off",
		file: "src/memory.ts",
		find: `  return m.repo === reader.scope.key || (!!m.repoPath && m.repoPath === reader.scope.path);`,
		replace: `  return true;`,
		invariant: "another repo's rows never surface or get deleted here",
		class: "guard",
	},
	{
		id: "content-cap-off",
		file: "src/memory.ts",
		find: `  if (input.content.length > MAX_CONTENT_CHARS) {`,
		replace: `  if (false) {`,
		invariant: "nothing oversized is persisted (append floor)",
		class: "guard",
	},
	{
		id: "gate-blocks-ignored",
		file: "src/gates.ts",
		find: `  if (blockReason) {`,
		replace: `  if (false) {`,
		invariant: "a write rejected by a gate never reaches the store",
		class: "D1",
	},
	{
		id: "gate-dupes-promoted",
		file: "src/gates.ts",
		find: `    return { action: "collapsed", chain, collapsedWith: collapseMatch.ts };`,
		replace: `    return { action: "promoted", chain, ts: collapseMatch.ts };`,
		invariant: "a near-duplicate is collapsed, not stored twice",
		class: "D1",
	},
	{
		id: "gate-content-cap-off",
		file: "src/gates.ts",
		find: `  if (candidate.content.length > MAX_CONTENT_CHARS) {`,
		replace: `  if (false) {`,
		invariant: "oversized content is blocked with a reason, not stored",
		class: "guard",
	},
	{
		id: "inject-one-token-shared",
		file: "src/inject.ts",
		find: `  const needShared = query.size >= LONG_QUERY_TOKENS ? 2 : 1;`,
		replace: `  const needShared = 1;`,
		invariant: "free-text prompts need two shared concepts to inject",
		class: "pure",
	},
	{
		id: "inject-frontier-uncapped",
		file: "src/inject.ts",
		find: `const OPEN_THREAD_LIMIT = 3;`,
		replace: `const OPEN_THREAD_LIMIT = 500;`,
		invariant: "only the newest open threads are surfaced",
		class: "pure",
	},
	{
		id: "viewer-origin-guard-off",
		file: "src/viewer/server.ts",
		find: `  if (origin !== null && origin !== url.origin) return error("cross-origin request refused", 403);`,
		replace: `  if (origin !== null && false) return error("cross-origin request refused", 403);`,
		invariant: "cross-origin writes to the viewer are refused",
		class: "guard",
	},
	{
		id: "import-frontier-any-version",
		file: "src/portable.ts",
		find: `        allowFrontier = hdr.version <= EXPORT_VERSION;`,
		replace: `        allowFrontier = true;`,
		invariant: "a newer export header does not grant the frontier exemption",
		class: "guard",
	},
	{
		id: "import-open-status-unconditional",
		file: "src/portable.ts",
		find: `    if (c.status === "open" && (!allowFrontier || claimedGlobal || (hadStamp && !currentScope))) {`,
		replace: `    if (false) {`,
		invariant: "status:open is honored only under its guards (export header, own repo, current scope)",
		class: "guard",
	},
];

// Calibration mutant (--selftest only, never part of the score): a trivially
// tested PURE function. quote() stops quoting space-bearing values; the logfmt
// round-trip table kills it deterministically. If THIS survives, the
// instrument (or the suite) is broken and nothing else it reports means
// anything - the meta-lesson of #68.
const SELFTEST_MUTANT: Mutant = {
	id: "selftest-quote-grammar",
	file: "src/logfmt.ts",
	find: `return /` + QUOTE_CLASS + `/.test(s)`,
	replace: `return /` + QUOTE_CLASS_PLAIN + `/.test(s)`,
	invariant: "logfmt quotes any value containing whitespace (calibration plant)",
	class: "pure",
};

// ---------------------------------------------------------------------------
// Known-flaky (timing-sensitive) tests on Windows. A kill resting ONLY on
// these is rerun before it counts; a baseline failure here is accounted for,
// never charged to a mutant. The family is wider than the three names quoted
// in #68 on this machine: Windows lock-file opens and renames hit sharing
// violations (EPERM) whenever a reader holds the target file open, so every
// racing test in concurrency.test.ts, the cross-process lock test and the
// cross-process scenarios-consistency suite share the family.
// ---------------------------------------------------------------------------
const FLAKY_PATTERNS: RegExp[] = [
	/four writers/,
	/reader process always parses a complete file/,
	/second process waits/,
	/half-written/, // "a concurrent reader never sees a half-written file"
	/supersede racing appends > /,
	/prune racing appends > /,
	/restore racing appends > /,
	/two processes sharing one store > /,
	/a snapshot restore while other sessions are writing > /,
	/two sessions rewriting one day file > /,
	/a prune sweep while another session is appending > /,
	/the viewer deleting and editing while another session writes > /,
	/restore in check and merge mode while sessions write > /,
	/an import landing while another session writes > /,
];
const isFlaky = (name: string): boolean => FLAKY_PATTERNS.some((re) => re.test(name));

// Baseline failures this machine is known to produce (reported, do not block
// the sweep; run with a bun >= 1.4 via --bun= to clear the resolver trio).
// Anything else the baseline fails blocks the sweep (fail closed) unless
// --allow-baseline-failures.
const KNOWN_BASELINE_FAILS: RegExp[] = [
	/signature-update-turn/,
	/incoming-stale write/,
	/does NOT bypass the stale-ref poisoning guard/,
	...FLAKY_PATTERNS,
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit?.slice(name.length + 3);
};

const REPEAT = Math.max(1, Number(opt("repeat") ?? "1"));
const JOBS = Math.max(1, Number(opt("jobs") ?? "1"));
const CONFIRM = Math.max(REPEAT, Number(opt("confirm") ?? "3"));
const TIMEOUT_S = Math.max(10, Number(opt("timeout") ?? "600"));
const TEST_BUN = opt("bun") ?? process.execPath;
const ONLY = opt("mutant")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
const LOG_PATH = opt("log");

interface RunEvent {
	mutant: string;
	phase?: "result";
	tests?: string[];
	skipped?: string[];
	delta?: string[];
	status?: string;
	tail?: string;
}
const runEvents = new Map<string, RunEvent[]>();
function logEvent(e: RunEvent): void {
	const list = runEvents.get(e.mutant) ?? [];
	list.push(e);
	runEvents.set(e.mutant, list);
	if (LOG_PATH) {
		writeFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`, { flag: "a" });
	}
}

// ---------------------------------------------------------------------------
// Scratch worktrees: the mutated copy lives nowhere near the checkout.
// ---------------------------------------------------------------------------
function run(cmd: string[], cwd?: string): { code: number; out: string; stdout: string } {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const stdout = p.stdout.toString();
	return { code: p.exitCode ?? 1, out: stdout + p.stderr.toString(), stdout };
}

const scratches: string[] = [];
// Tear a scratch worktree down completely: junction first (rmdir on a mount
// point never follows it), then git's registration, then the directory. A
// stranded test child can hold files open for a while, so retry generously.
function removeScratch(dir: string): boolean {
	if (dirname(resolve(dir)) !== resolve(SCRATCH_ROOT) || !/^w\d+(?:-ghost-[a-z0-9]+)?$/.test(basename(dir))) {
		throw new Error(`refusing cleanup outside the sweep scratch root: ${dir}`);
	}
	const link = join(dir, "node_modules");
	if (existsSync(link)) {
		try {
			rmdirSync(link);
		} catch {
			/* already gone */
		}
	}
	run(["git", "-C", REPO, "worktree", "remove", "--force", dir]);
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	} catch {
		/* the verdict below decides */
	}
	return !existsSync(dir);
}
let cleanedUp = false;
function cleanup(): void {
	if (cleanedUp || flag("keep")) return;
	cleanedUp = true;
	for (const dir of scratches) removeScratch(dir);
	run(["git", "-C", REPO, "worktree", "prune"]);
	// Loud guard: junction plumbing must never eat the real node_modules.
	if (!existsSync(join(REPO, "node_modules"))) {
		console.error("FATAL: the checkout's node_modules vanished during cleanup - investigate immediately.");
	}
}
process.on("exit", cleanup);

// Does the scratch actually resolve its dependencies? A junction (Windows) is a
// directory git clean never touches; a symlink (POSIX) is untracked-and-unignored
// (node_modules/ has a trailing slash, so it matches directories only) and
// `git clean -fdq` deletes it before EVERY mutant run - leaving the whole suite
// zod-starved, dying as file-level unhandled errors no verdict path can see
// (#110 review: this silently invalidated every macOS measurement). Verify the
// view - after creation AND after every reset - so a dead link can never run a
// blind suite. Returns true when node_modules is reachable.
function verifyScratchView(dir: string): boolean {
	return existsSync(join(dir, "node_modules", "zod", "package.json"));
}

// (Re)create the scratch's node_modules link, Windows-junction or POSIX-symlink
// alike, and make sure it points at a real dependency tree.
function ensureScratchLink(dir: string): void {
	const nm = join(REPO, "node_modules");
	if (!existsSync(nm)) {
		console.warn(`warning: ${nm} not found - the suite needs its dependencies (bun install first)`);
		return;
	}
	const link = join(dir, "node_modules");
	if (verifyScratchView(dir)) return;
	// A dangling link (target deleted) or an absent one: recreate it. rmdirSync
	// clears a junction dir; the symlink case needs unlink (rmdir throws ENOTDIR).
	try {
		symlinkSync(nm, link, "junction");
	} catch {
		try {
			unlinkSync(link);
		} catch {
			/* nothing to remove */
		}
		symlinkSync(nm, link, "junction");
	}
	if (!verifyScratchView(dir)) {
		throw new Error(`scratch ${dir} cannot reach node_modules - refusing to run a blind suite`);
	}
}

function makeScratch(i: number): string {
	let dir = join(SCRATCH_ROOT, `w${i}`);
	if (!removeScratch(dir)) {
		// a ghost locked by a stranded process must not block the whole sweep
		dir = join(SCRATCH_ROOT, `w${i}-ghost-${Date.now().toString(36)}`);
		console.warn(`warning: old scratch w${i} is locked by a stranded process - moved to ${dir} (prune it later)`);
		removeScratch(dir);
	}
	for (let tries = 3; tries > 0; tries--) {
		const add = run(["git", "-C", REPO, "worktree", "add", "--detach", dir, "HEAD"]);
		if (add.code === 0) break;
		if (tries === 1) throw new Error(`git worktree add failed: ${add.out}`);
		run(["git", "-C", REPO, "worktree", "prune"]);
		Bun.sleepSync(500);
	}
	scratches.push(dir);
	ensureScratchLink(dir); // create the link, verify the view - loudly
	return dir;
}

function resetScratch(dir: string): void {
	// node_modules/ in .gitignore has a TRAILING SLASH - it matches directories
	// only. A Windows junction is one, so `clean -fd` (no -x) left it; on POSIX
	// the scratch's node_modules is a symlink: untracked, NOT ignored (check-
	// ignore exits 1), and a bare `clean -fdq` deleted it before every run,
	// leaving every mutant run zod-starved (#110 review). Belt: -e excludes the
	// name on every platform. Braces: ensureScratchLink after the clean.
	run(["git", "-C", dir, "checkout", "--", "."]);
	run(["git", "-C", dir, "clean", "-fdq", "-e", "node_modules"]);
	// Self-heal: a stranded test child or a deferred Windows file operation can
	// disturb the tree after a run (observed in #70: a tracked source file went
	// missing between two mutants). If git still sees dirt, rebuild the worktree.
	// stdout only: git's CRLF chatter on stderr is not dirt. And neither is
	// the node_modules link (#110 approval note 1): `clean -e` keeps it, but
	// untracked-and-unignored it lists as `?? node_modules` on every POSIX
	// status - not dirt, but the reset's own plumbing, owned by
	// ensureScratchLink below. Counting it as dirt rebuilt the whole worktree
	// on EVERY reset (measured: 51.6s where 25s is honest). Windows junctions
	// match the gitignored `node_modules/` directory rule and never appear.
	const dirt = run(["git", "-C", dir, "status", "--porcelain"])
		.stdout.split("\n")
		.filter((l) => !/^\?\? node_modules\/?$/.test(l.trim()))
		.join("\n")
		.trim();
	if (dirt !== "") {
		console.warn(`  scratch ${dir} came back dirty - rebuilding it (${cut(dirt.replace(/\n/g, " | "), 160)})`);
		if (!removeScratch(dir)) throw new Error(`cannot rebuild scratch ${dir}: locked and nonempty`);
		let add = run(["git", "-C", REPO, "worktree", "add", "--detach", dir, "HEAD"]);
		if (add.code !== 0) {
			run(["git", "-C", REPO, "worktree", "prune"]);
			add = run(["git", "-C", REPO, "worktree", "add", "--detach", dir, "HEAD"]);
			if (add.code !== 0) throw new Error(`cannot rebuild scratch ${dir}: ${add.out}`);
		}
		ensureScratchLink(dir);
		Bun.sleepSync(2000); // a rebuild is rare and deserves a hard settle
	}
	ensureScratchLink(dir); // the clean above must never leave a blind scratch
	Bun.sleepSync(300); // let deferred deletes settle before the next run starts
}

function applyMutant(dir: string, m: Mutant): void {
	const path = join(dir, m.file);
	let raw: string;
	for (let tries = 2; ; tries--) {
		try {
			raw = readFileSync(path, "utf8");
			break;
		} catch (err) {
			// A stranded test child can leave a tracked source file MISSING in the
			// scratch (observed on Windows between mutants). Rebuild before the
			// read rather than crashing on it - the self-heal in resetScratch.
			if (tries === 1 || !removeScratch(dir)) throw err;
			console.warn(`  ${m.id}: ${m.file} unreadable in scratch - rebuilt before applying`);
			let add = run(["git", "-C", REPO, "worktree", "add", "--detach", dir, "HEAD"]);
			if (add.code !== 0) {
				run(["git", "-C", REPO, "worktree", "prune"]);
				add = run(["git", "-C", REPO, "worktree", "add", "--detach", dir, "HEAD"]);
				if (add.code !== 0) throw err;
			}
			const nm = join(REPO, "node_modules");
			if (existsSync(nm)) {
				try {
					symlinkSync(nm, join(dir, "node_modules"), "junction");
				} catch {
					/* already linked */
				}
			}
		}
	}
	const eol = raw.includes("\r\n") ? "\r\n" : "\n";
	const text = eol === "\n" ? raw : raw.replace(/\r\n/g, "\n");
	const hits = text.split(m.find).length - 1;
	if (hits !== 1) {
		throw new Error(`mutant ${m.id}: pattern matched ${hits} sites in ${m.file} (validate should have caught this)`);
	}
	writeFileSync(path, text.replace(m.find, () => m.replace).split("\n").join(eol));
}

// ---------------------------------------------------------------------------
// Suite run + result parsing
// ---------------------------------------------------------------------------
interface SuiteRun {
	exit: number;
	seconds: number;
	timedOut: boolean;
	pass: number;
	fail: number;
	skip: number;
	/** test-level failures, named "<file> > <suite> > <test>" */
	failed: string[];
	passed: string[];
	skipped: string[];
	/** file-level failures (module load / describe body): never a kill */
	fileFailed: string[];
	errorMarkers: string[];
	/** raw tail of the run's output - the autopsy of an interrupted run */
	tail: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the control character we strip
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function suiteEnv(): Record<string, string> {
	// Pin what the children see (#68 meta-lesson: never let an ambient
	// OPENCODE_MEMORY_DIR hijack the run). Everything else stays intact.
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !k.startsWith("OPENCODE_")) env[k] = v;
	}
	return env;
}

async function runSuite(dir: string): Promise<SuiteRun> {
	const t0 = Date.now();
	const proc = Bun.spawn([TEST_BUN, "test", "./test/"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: suiteEnv(),
		timeout: TIMEOUT_S * 1000,
	});
	// If the process group wedges (the spawn timeout can miss grandchildren
	// holding the pipes), race it and hard-kill rather than hang the sweep.
	const outcome = await Promise.race([proc.exited, Bun.sleep(TIMEOUT_S * 1000 + 30_000).then(() => "stuck" as const)]);
	if (outcome === "stuck") {
		try {
			proc.kill(true);
		} catch {
			/* gone */
		}
	}
	const out = ((await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())).replace(ANSI, "");
	const seconds = (Date.now() - t0) / 1000;
	// Summary counters, NOT a first-match scan: on some platforms Bun echoes every
	// "(pass) <title>" line into the pipe, and a title like "...1.10.0 passes the
	// 1.3.0 floor..." contains a spurious "0 pass" that a /(\d+) pass/ first-match
	// reports as the tally (found on Linux, Bun 1.4.4 - the baseline parsed 0 and
	// the whole sweep refused to start). Anchor to the summary's whole line and
	// take the LAST occurrence; (pass)-lines can never match the anchor.
	const num = (label: string): number => {
		const all = [...out.matchAll(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, "gm"))];
		return all.length ? Number(all[all.length - 1]?.[1] ?? "0") : 0;
	};
	const { passed, skipped, failed, fileFailed } = testOutcomes(out);
	return {
		exit: proc.exitCode ?? 1,
		seconds,
		timedOut: (proc as { timedOut?: boolean }).timedOut === true || outcome === "stuck",
		pass: num("pass"),
		fail: num("fail"),
		skip: num("skip"),
		failed,
		passed,
		skipped,
		fileFailed,
		errorMarkers: [...out.matchAll(/(SyntaxError: [^\n]*|Transform failed[^\n]*|Cannot find (?:module|package)[^\n]*)/g)].map((x) => x[1] ?? ""),
		tail: out.slice(-1500),
	};
}

// Total outcomes (pass+fail+skip) of the baseline run. A mutant run that
// accounts for far fewer tests than the baseline never reached the end of the
// suite (an infra hiccup, an interrupted spawn) - it cannot testify about the
// mutant and must never be scored as a silent survive.
let BASELINE_TOTAL = 0;

function classify(r: SuiteRun, baselinePass: number, baselineFailCount: number): "compile-error" | "runtime-error" | "ok" {
	if (r.errorMarkers.length > 0 && r.fileFailed.length > 0) return "compile-error";
	if (r.pass === 0 && r.failed.length === 0 && r.fileFailed.length === 0) return "runtime-error";
	if (r.fileFailed.length > 0 && r.pass < baselinePass / 2) return "compile-error";
	if (BASELINE_TOTAL > 0 && r.pass + r.fail + r.skip + r.fileFailed.length < 0.8 * BASELINE_TOTAL) {
		// Truncated tally: the runner stopped early. That is only "we could not
		// measure" when nothing significant DIED before the stop. A mutant that
		// reddens many tests and also crashes the runner between tests - the
		// exact shape of the calibration plant's quote-grammar breakage on
		// macOS (137 pass / 57 fail / truncated to 198 tests) - is a KILL that
		// happened to be truncated, not an instrument failure (#110 review).
		if (r.failed.length + r.fileFailed.length >= 3) return "ok"; // deltaOf() below rules kill
		if (r.fail - baselineFailCount >= 3) {
			// The summary counts deaths the named-line parse cannot show - the
			// signature of file-level unhandled errors (a zod-starved scratch
			// looks exactly this way: 148 pass / 58 fail / 0 names, #110 review).
			// No names means no delta, and a delta-less green would be a silent
			// survive on a truncated tally. This is an instrument failure, said
			// out loud, never a verdict.
			console.warn(
				`  instrument: truncated tally ${r.pass} pass / ${r.fail} fail names only ${r.failed.length} deaths` +
					` (${r.fileFailed.length} file-level) - suite is dying unnameably, refusing to verdict`,
			);
			return "runtime-error";
		}
		return "runtime-error";
	}
	return "ok";
}

// ---------------------------------------------------------------------------
// --validate: every mutation applies to exactly one site. No test runs.
// ---------------------------------------------------------------------------
function validate(quiet = false): boolean {
	let ok = true;
	const ids = new Set<string>();
	for (const m of [...MUTANTS, SELFTEST_MUTANT]) {
		const problems: string[] = [];
		if (ids.has(m.id)) problems.push("duplicate id");
		ids.add(m.id);
		if (!m.file.startsWith("src/")) problems.push("mutates a non-src path");
		if (m.find === m.replace) problems.push("replacement identical to find");
		const path = join(REPO, m.file);
		if (!existsSync(path)) problems.push(`file missing: ${m.file}`);
		else {
			const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
			const hits = text.split(m.find).length - 1;
			if (hits !== 1) problems.push(`pattern applies to ${hits} sites (must be exactly 1) in ${m.file}`);
		}
		if (problems.length) {
			ok = false;
			console.log(`  FAIL  ${m.id}: ${problems.join("; ")}`);
		} else if (!quiet) {
			console.log(`  ok    ${m.id}  ${m.file}`);
		}
	}
	return ok;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------
type Status = "killed" | "survived" | "timeout" | "runtime-error" | "compile-error" | "equivalent";

interface MutantResult {
	m: Mutant;
	status: Status;
	runsKilled: number;
	runs: number;
	killers: string[];
	notes: string[];
	seconds: number;
}

const fmt = (n: number): string => `${n.toFixed(1)}s`;
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

async function sweepMutant(dir: string, m: Mutant, baselineFail: Set<string>, baselinePass: number): Promise<MutantResult> {
	const notes: string[] = [];
	const killers = new Set<string>();
	const events = (): RunEvent[] => runEvents.get(m.id) ?? [];
	const deltaOf = (r: SuiteRun): string[] => r.failed.filter((t) => !baselineFail.has(t));
	const allDeltaFlaky = (e: RunEvent): boolean => (e.delta ?? []).length === 0 || (e.delta ?? []).every(isFlaky);
	let runs = 0;
	let runsKilled = 0;
	let seconds = 0;

	const oneRun = async (): Promise<SuiteRun | "timeout" | "compile-error" | "runtime-error"> => {
		runs++;
		// A run only testifies about the tree it was promised: if something undid
		// (or deleted) the mutation meanwhile, a green run would be a lie.
		let intact = false;
		try {
			intact = readFileSync(join(dir, m.file), "utf8").replace(/\r\n/g, "\n").includes(m.replace);
		} catch {
			intact = false;
		}
		if (!intact) {
			notes.push("the mutation had been disturbed before a run - scratch rebuilt and reapplied");
			resetScratch(dir);
			applyMutant(dir, m);
		}
		const r = await runSuite(dir);
		seconds += r.seconds;
		if (r.timedOut) {
			logEvent({ mutant: m.id, status: "timeout" });
			return "timeout";
		}
		const kind = classify(r, baselinePass, baselineFail.size);
		if (kind !== "ok") {
			logEvent({ mutant: m.id, status: kind, tail: r.tail.slice(-600) });
			return kind;
		}
		const delta = deltaOf(r);
		if (delta.length) {
			runsKilled++;
			for (const t of delta) killers.add(t);
		}
		logEvent({ mutant: m.id, delta });
		return r;
	};

	// The scratch handed to a mutant is either fresh (jobs=1 reuses one tree) or
	// the site of the PREVIOUS mutant's last run. Reset before the first apply,
	// not just between runs of this mutant - otherwise applyMutant reads a tree
	// a stranded child may have disturbed.
	resetScratch(dir);
	applyMutant(dir, m);
	try {
		for (let i = 0; i < REPEAT; i++) {
			if (i > 0) {
				resetScratch(dir);
				applyMutant(dir, m);
			}
			let r = await oneRun();
			if (r === "timeout") {
				return { m, status: "timeout", runsKilled, runs, killers: [], notes: [`suite run exceeded ${TIMEOUT_S}s (a hang under this mutant is a finding in itself)`], seconds };
			}
			if (r === "runtime-error") {
				// a run that died mid-suite testifies about nothing (infra, not mutant):
				// rebuild the scratch and let it testify once more.
				notes.push("a run died before the suite finished (infra, not mutant) - retried once");
				resetScratch(dir);
				applyMutant(dir, m);
				r = await oneRun();
			}
			if (r !== "ok" && typeof r !== "object") {
				return {
					m, status: r, runsKilled, runs, killers: [],
					notes: [r === "compile-error" ? "informational, never a kill (#70)" : "suite could not load the mutated tree"],
					seconds,
				};
			}
		}
		// Rerun policy: a kill resting only on timing-sensitive tests is not a
		// kill until confirmed on every run (a flake must never masquerade).
		if (runsKilled > 0 && events().every(allDeltaFlaky) && runs < CONFIRM) {
			notes.push(`needs-rerun: kill evidence is timing-sensitive only (${runsKilled}/${runs}) - confirming to ${CONFIRM} runs`);
			while (runs < CONFIRM) {
				resetScratch(dir);
				applyMutant(dir, m);
				const r = await oneRun();
				if (typeof r !== "object") {
					notes.push(`a confirmation run came back ${r}`);
					break;
				}
			}
		}
	} finally {
		resetScratch(dir);
	}

	let status: Status;
	if (runsKilled === 0) status = m.equivalent ? "equivalent" : "survived";
	else if (runsKilled < runs) {
		status = "survived";
		notes.push(`unstable kill (${runsKilled}/${runs} runs) - timing luck, D2 per #68, not credited`);
	} else {
		status = "killed";
		if (events().every(allDeltaFlaky)) notes.push(`killed only by timing-sensitive tests, confirmed ${runsKilled}/${runs}`);
		if (m.equivalent) notes.push("WARNING: marked equivalent but it DIES - the equivalence claim is wrong");
	}
	return { m, status, runsKilled, runs, killers: [...killers], notes, seconds };
}

function printTable(results: MutantResult[], wallS: number, baselineSeconds: number, baselineFail: string[]): void {
	for (const r of results) logEvent({ mutant: r.m.id, phase: "result", status: r.status, delta: r.killers });
	const head = ["status", "runs", "id", "cls", "invariant"];
	const rows = results.map((r) => [
		r.status,
		r.status === "killed" || r.status === "survived" ? `${r.runsKilled}/${r.runs}` : "-",
		r.m.id,
		r.m.class,
		cut(r.m.invariant, 62),
	]);
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
	console.log(`\n${head.map((h, i) => h.padEnd(widths[i]!)).join("  ")}  net`);
	console.log(widths.map((w) => "-".repeat(w)).join("  "));
	for (let i = 0; i < results.length; i++) {
		const r = results[i]!;
		console.log(`${rows[i]!.map((c, j) => c.padEnd(widths[j]!)).join("  ")}  ${r.m.scenario ? "scenario" : ""}`);
		for (const n of r.notes) console.log(`${" ".repeat(widths[0]! + 2)}* ${n}`);
		if (r.status === "killed" && r.killers.length) {
			const files = [...new Set(r.killers.map((k) => k.split(" > ")[0]!))];
			console.log(`${" ".repeat(widths[0]! + 2)}<- killed by: ${cut(files.join(", "), 100)}`);
		}
	}
	const killed = results.filter((r) => r.status === "killed").length;
	const equivalent = results.filter((r) => r.status === "equivalent").length;
	const info = results.filter((r) => r.status === "compile-error" || r.status === "runtime-error").length;
	const scored = results.length - equivalent - info;
	console.log(
		`\nmutation score (canonical, equivalents & load-errors excluded): ` +
			`${killed}/${scored} = ${scored ? ((100 * killed) / scored).toFixed(1) : "0.0"}%   ` +
			`(${results.length} mutants | ${equivalent} equivalent | ${info} informational)`,
	);
	const survivors = results.filter((r) => r.status === "survived" || r.status === "timeout");
	if (survivors.length) {
		console.log(`\nunpinned invariants (survivors - this is the audit's output, not a scandal):`);
		for (const s of survivors) console.log(`  ${s.m.id}  [${s.m.class}]  ${s.m.invariant}`);
	}
	const eq = results.filter((r) => r.m.equivalent);
	if (eq.length) {
		console.log(`\nequivalent mutants (excluded from the denominator):`);
		for (const e of eq) console.log(`  ${e.m.id}: ${e.m.equivalent}`);
	}
	const sum = results.reduce((a, r) => a + r.seconds, 0);
	console.log(
		`\nwall ${fmt(wallS)} (baseline ${fmt(baselineSeconds)} + ${results.length} mutants x suite on ` +
			`${JOBS} scratch worktree(s)); suite-run sum ${fmt(sum)}${
			JOBS > 1 ? `; parallel efficiency ${(sum / Math.max(0.001, wallS - baselineSeconds)).toFixed(2)} - contention, which is why the default is jobs=1` : ""
		}`,
	);
	if (baselineFail.length) console.log(`baseline accounted for: ${baselineFail.length} known failing test(s) excluded from every kill delta`);
}

async function main(): Promise<number> {
	if (flag("list")) {
		for (const m of MUTANTS) {
			console.log(
				`${m.id.padEnd(32)} ${m.class.padEnd(6)} ${m.file.padEnd(22)} ${m.scenario ? "scenario" : "unit   "} ${m.invariant}${m.equivalent ? "  [equivalent]" : ""}`,
			);
		}
		return 0;
	}

	console.log(`mutation sweep - ${MUTANTS.length} mutants | repeat=${REPEAT} confirm=${CONFIRM} jobs=${JOBS} timeout=${TIMEOUT_S}s`);
	console.log(`repo: ${REPO}`);
	console.log(`suite runner: ${TEST_BUN} (${run([TEST_BUN, "--version"]).out.trim()})`);

	if (flag("validate")) {
		console.log(`\n--validate: ${MUTANTS.length + 1} mutation patterns (incl. the calibration plant)`);
		const ok = validate();
		console.log(ok ? "validate: every mutation applies to exactly one site" : "validate: FAILED - see above (exiting nonzero)");
		return ok ? 0 : 1;
	}
	if (!validate(true)) {
		console.error("mutant table is inconsistent - run --validate for details");
		return 1;
	}

	const targets = ONLY.length ? MUTANTS.filter((m) => ONLY.includes(m.id)) : MUTANTS;
	if (ONLY.length && targets.length !== new Set(ONLY).size) {
		console.error(`unknown mutant id(s): ${ONLY.filter((o) => !MUTANTS.some((m) => m.id === o)).join(", ")}`);
		return 1;
	}

	makeScratch(0);
	if (!flag("baseline") && JOBS > 1) for (let i = 1; i < JOBS; i++) makeScratch(i);
	let baseDir = scratches[0]!;

	console.log(`\n=== baseline: clean HEAD must be green (or red only on the known family) ===`);
	let base = await runSuite(baseDir);
	if (base.pass === 0 && base.fail > 0 && !base.timedOut) {
		// a scratch whose tree cannot import anything would poison every verdict:
		// rebuild once and demand a second testimony (#70).
		console.warn("  baseline imported nothing - rebuilding the scratch and rerunning it");
		removeScratch(baseDir);
		makeScratch(0);
		baseDir = scratches[0]!;
		base = await runSuite(baseDir);
	}
	const baselineFail = new Set(base.failed);
	if (base.pass > 0 && base.passed.length === 0) {
		console.warn("  baseline has passing tests but no harvested test identifiers: this Bun build/output mode may omit (pass)/(skip) lines; triage-71.ts cannot build a per-test ledger from this log (validated with Bun 1.4.4 on Windows)");
	}
	console.log(`  ${base.pass} pass / ${base.fail} fail / ${base.skip} skip in ${fmt(base.seconds)}`);
	for (const name of base.failed) {
		console.log(`  ${KNOWN_BASELINE_FAILS.some((re) => re.test(name)) ? "known" : "NEW "}  ${cut(name, 100)}`);
	}
	logEvent({ mutant: "baseline", delta: base.failed, tests: base.passed, skipped: base.skipped });
	BASELINE_TOTAL = base.pass + base.fail + base.skip + base.fileFailed.length;
	if (base.pass === 0 || base.timedOut) {
		console.error("baseline produced no results - nothing is measurable (exit 3)");
		return 3;
	}
	const unknown = base.failed.filter((t) => !KNOWN_BASELINE_FAILS.some((re) => re.test(t)));
	if (unknown.length && !flag("allow-baseline-failures")) {
		console.error(`baseline is red on ${unknown.length} test(s) outside the known family - sweep aborted (exit 3; override: --allow-baseline-failures)`);
		return 3;
	}
	if (flag("baseline")) return 0;

	const selected = flag("selftest") ? [SELFTEST_MUTANT] : targets;

	if (flag("selftest")) {
		console.log(`\n=== --selftest: calibration - the instrument must be able to fail (#68 meta-lesson) ===`);
		const r = await sweepMutant(baseDir, SELFTEST_MUTANT, baselineFail, base.pass);
		console.log(`  plant: ${SELFTEST_MUTANT.id} -> ${r.status} (${r.runsKilled}/${r.runs}, ${fmt(r.seconds)})`);
		for (const k of r.killers.slice(0, 5)) console.log(`    killed by: ${cut(k, 96)}`);
		if (r.status !== "killed") {
			console.error(`\nSELFTEST FAILED: the sweep cannot kill a planted mutation of a`);
			console.error(`trivially-tested pure function. This measurement CANNOT FAIL, so`);
			console.error(`every other status it prints - every "killed", every score - means nothing.`);
			return 2;
		}
		console.log("selftest: the instrument bites (a harness that cannot go red is itself a defect)");
		return 0;
	}

	console.log(`\n=== sweeping ${selected.length} mutant(s), ${REPEAT} run(s) each ===`);
	const t0 = Date.now();
	const results: MutantResult[] = [];
	if (JOBS === 1) {
		for (const m of selected) {
			const r = await sweepMutant(baseDir, m, baselineFail, base.pass);
			results.push(r);
			console.log(`  ${r.status.padEnd(15)} ${m.id} (${r.runsKilled}/${r.runs}) ${fmt(r.seconds)}`);
		}
	} else {
		const queue = [...selected];
		await Promise.all(
			scratches.map((dir) =>
				(async () => {
					for (;;) {
						const m = queue.shift();
						if (!m) return;
						const r = await sweepMutant(dir, m, baselineFail, base.pass);
						results.push(r);
						console.log(`  ${r.status.padEnd(15)} ${m.id} (${r.runsKilled}/${r.runs}) ${fmt(r.seconds)}`);
					}
				})(),
			),
		);
		results.sort((a, b) => selected.indexOf(a.m) - selected.indexOf(b.m));
	}
	printTable(results, (Date.now() - t0) / 1000, base.seconds, base.failed);

	const survivors = results.filter((r) => r.status === "survived" || r.status === "timeout");
	if (flag("fail-on-survivors") && survivors.length) return 4;
	return 0;
}

if (import.meta.main) process.exit(await main());
