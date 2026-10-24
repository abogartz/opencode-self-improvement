// Whole-system consistency scenarios.
//
// scenarios.test.ts pins the plugin contract one call at a time. These replay a
// *situation*: several sessions writing one store from separate OS processes
// while a human restores a snapshot, prunes, edits or imports through the
// viewer's HTTP boundary. The promise is conservation — a row a session was
// told it remembered is either in the live store or in a snapshot it can be
// recovered from. Never nowhere.
//
// Written to run against an OLD checkout unchanged: it touches only APIs whose
// signature is identical on both sides of the store-lock fix and asserts only
// observable state (file contents), never a result shape. That makes
// red-before / green-after an actual command instead of a claim:
//
//   wt=/tmp/osi-pre && git worktree add --detach "$wt" 357ecaf^
//   ln -s "$PWD/node_modules" "$wt/node_modules"
//   bun test ./test/scenarios-consistency.test.ts   # run inside "$wt"
//
// Which scenarios are red on 357ecaf^ and why: the lockless whole-file rewrites
// (restore, supersede, prune, viewer edit/delete) open a read→publish window in
// the pre-fix code, and an append landing inside it survives in neither the
// published file nor the pre-mutation snapshot — nowhere. Appends themselves
// have been O_APPEND-safe since before that commit, so the import and
// check-mode scenarios pin promises that never broke ("land row-wise, never
// clobber", "check never mutates") and are expected green on both sides. A
// batch-supersede scenario waits for that API to exist.
//
// The technique, because a scenario that fails "usually" is not a regression
// net: control the schedule instead of hoping. Start writers, wait until they
// are demonstrably mid-flight (reports on disk), then fire many rewrite windows
// back to back — one window is a coin toss, eight is a net. Assert
// conservation over file contents only, never a result shape.
//
// Child processes are pinned to this run's store by ARGV, not inherited env:
// Bun.spawn does not pass the parent environment by default, and relying on
// inheritance sent 140 test rows into the developer's real store. The temp-root
// guard in the child preamble is the second line of defence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { dateStr, memoryRoot, snapshotDir } from "../src/config.ts";
import { runWriteGate, type GateContext } from "../src/gates.ts";
import { formatLine } from "../src/logfmt.ts";
import { prune, snapshotFiles } from "../src/memory.ts";
import {
	EXPORT_HEADER,
	EXPORT_VERSION,
	importMemories,
} from "../src/portable.ts";
import { restoreSnapshot } from "../src/undo.ts";
import { startViewer, type ViewerServer } from "../src/viewer/server.ts";

const SRC = join(import.meta.dir, "..", "src");

let root: string;
let vm: ViewerServer;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "osi-cons-"));
	process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
	process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
	mkdirSync(memoryRoot(), { recursive: true });
	vm = await startViewer(0);
});

afterEach(() => {
	vm.server.stop();
	delete process.env.OPENCODE_MEMORY_DIR;
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const store = () => join(memoryRoot(), `${dateStr()}.logfmt`);

/** Seed the day file directly with `pad`-padded rows per scope; rows must exist
 *  before any process races on them. Returns the ts list of every scope. */
function seedScopes(
	pad: number,
	blocks: [scope: string, rows: number][],
): Map<string, string[]> {
	let i = 0;
	const base = Date.now() - 10_000;
	const lines: string[] = [];
	const out = new Map<string, string[]>();
	for (const [scope, rows] of blocks) {
		const tsList: string[] = [];
		for (let k = 0; k < rows; k++, i++) {
			const ts = new Date(base + i).toISOString();
			tsList.push(ts);
			lines.push(
				formatLine({
					ts,
					type: "learning",
					scope,
					content: `seed ${scope} ${i} ${"x".repeat(pad)}`,
				}),
			);
		}
		out.set(scope, tsList);
	}
	writeFileSync(store(), `${lines.join("\n")}\n`);
	return out;
}

/** Remove rows by ts straight from the store file (setup only — makes a later
 *  merge restore observable: what the scenario deleted, merge must bring back). */
function dropRows(ts: string[]): void {
	const drop = new Set(ts);
	const kept = readFileSync(store(), "utf8")
		.split("\n")
		.filter(Boolean)
		.filter((l) => !drop.has(l.match(/^ts=(\S+)/)?.[1] ?? ""));
	writeFileSync(store(), `${kept.join("\n")}\n`);
}

interface Writer {
	proc: Bun.Subprocess;
	report: string;
	label: string;
}

// The child is pinned to this run's store by argv[2]; it is a stand-in for
// another live session, so it writes through the tree's own memory.ts.
function childPreamble(role: string): string {
	return `import { appendFileSync } from "node:fs";
const dir = process.argv[2];
if (!dir || !dir.includes("osi-cons-")) {
  console.error("${role}: refusing to run against a non-temporary memory root: " + dir);
  process.exit(2);
}
process.env.OPENCODE_MEMORY_DIR = dir + "/memory";
process.env.OPENCODE_COMMANDS_DIR = dir + "/commands";
`;
}

/** A second session appending: it reports every ts it was handed, because
 *  "the tool said it stored it" is precisely the promise under test. */
function spawnRacer(label: string, rows: number): Writer {
	const report = join(root, `${label}.reported`);
	const script = join(root, `${label}.ts`);
	writeFileSync(
		script,
		`${childPreamble(label)}
const { appendMemory } = await import(${JSON.stringify(join(SRC, "memory.ts"))});
for (let i = 0; i < ${rows}; i++) {
  const ts = await appendMemory({
    type: "learning",
    scope: "consistency",
    content: "${label} row " + i + " " + "y".repeat(200),
  });
  appendFileSync(${JSON.stringify(report)}, ts + "\\n");
}
`,
	);
	return {
		proc: Bun.spawn({
			cmd: [process.execPath, "run", script, root],
			stdout: "ignore",
			stderr: "pipe",
		}),
		report,
		label,
	};
}

/** A session superseding rows in the same file: a read-modify-write. */
function spawnSuperseder(label: string, targets: string[]): Writer {
	const report = join(root, `${label}.reported`);
	const script = join(root, `${label}.ts`);
	writeFileSync(
		script,
		`${childPreamble(label)}
const { markSuperseded } = await import(${JSON.stringify(join(SRC, "memory.ts"))});
for (const ts of ${JSON.stringify(targets)}) {
  const ok = await markSuperseded(ts, { superseded_by: "${label}", reason: "consistency" });
  appendFileSync(${JSON.stringify(report)}, ts + (ok ? " ok" : " miss") + "\\n");
}
`,
	);
	return {
		proc: Bun.spawn({
			cmd: [process.execPath, "run", script, root],
			stdout: "ignore",
			stderr: "pipe",
		}),
		report,
		label,
	};
}

function reportLines(...files: string[]): string[] {
	const out: string[] = [];
	for (const f of files) {
		try {
			out.push(...readFileSync(f, "utf8").split("\n").filter(Boolean));
		} catch {
			/* not written yet */
		}
	}
	return out;
}

/** Everything recoverable: the live store plus every snapshot on disk. */
function recoverableCorpus(): string {
	const parts = [readFileSync(store(), "utf8")];
	for (const f of readdirSync(snapshotDir(), { recursive: true })) {
		try {
			parts.push(readFileSync(join(snapshotDir(), String(f)), "utf8"));
		} catch {
			/* a lock or temp file, not a snapshot */
		}
	}
	return parts.join("\n");
}

async function waitForRows(
	writers: Writer[],
	atLeast: number,
	timeoutMs = 20_000,
): Promise<void> {
	const reports = writers.map((w) => w.report);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (reportLines(...reports).length >= atLeast) return;
		await Bun.sleep(2);
	}
	throw new Error(
		`writers produced only ${reportLines(...reports).length}/${atLeast} rows before the window closed`,
	);
}

// A child that dies mid-run looks exactly like a lost row, so a silent failure
// here would turn a harness bug into a fake bug report.
async function finish(writers: Writer[]): Promise<void> {
	for (const w of writers) {
		await w.proc.exited;
		if (w.proc.exitCode !== 0) {
			const err = await new Response(w.proc.stderr as ReadableStream).text();
			throw new Error(
				`${w.label} exited ${w.proc.exitCode}: ${err.slice(0, 300)}`,
			);
		}
	}
}

function lostRows(writers: Writer[]): { lost: string[]; reported: number } {
	const reported = reportLines(...writers.map((w) => w.report)).map((l) =>
		l.trim(),
	);
	const corpus = recoverableCorpus();
	return {
		lost: reported.filter((ts) => !corpus.includes(`ts=${ts}`)),
		reported: reported.length,
	};
}

async function postApi(path: string, body: unknown): Promise<number> {
	const res = await vm.server.fetch(
		new Request(new URL(path, vm.url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return res.status;
}

describe("a snapshot restore while other sessions are writing", () => {
	test("every row a session was told it remembered is in the store or in a snapshot — never nowhere", async () => {
		// A realistically large day file: the window a restore opens is a whole-file
		// snapshot plus a whole-file publish, and that is the size at which it
		// swallows another session's rows on a heavy day.
		seedScopes(200, [["consistency", 6000]]);
		const [snap] = await snapshotFiles([store()]);
		const name = basename(snap);

		const writers = [spawnRacer("racer-a", 50), spawnRacer("racer-b", 50)];
		await waitForRows(writers, 6); // the racers are demonstrably mid-flight

		// Eight restores: one window is a coin toss, and a test that fails
		// "usually" is not a regression net. Each is the exact request the
		// viewer's restore button makes.
		for (let i = 0; i < 8; i++) {
			expect(await postApi("/api/restore", { name })).toBe(200);
		}
		await finish(writers);

		const { lost, reported } = lostRows(writers);
		expect(
			lost.length,
			`${lost.length} of ${reported} appended rows are in neither the store nor any snapshot: ${lost.slice(0, 5).join(", ")}`,
		).toBe(0);
		expect(reported).toBe(100);
	});
});

describe("two sessions rewriting one day file", () => {
	test("a supersede by one session and an append by another both survive", async () => {
		const rows = 60;
		const seeded = seedScopes(120, [["consistency", rows]]).get("consistency")!;

		const writers = [
			spawnSuperseder("sup-a", seeded.slice(0, 30)),
			spawnSuperseder("sup-b", seeded.slice(30)),
			spawnRacer("racer-c", 40),
		];
		await waitForRows(writers, 8);
		await finish(writers);

		// Lost updates first: a supersede whose write was clobbered leaves the row
		// unsuperseded forever, silently.
		const notApplied = seeded.filter(
			(ts) =>
				!readFileSync(store(), "utf8").includes(`ts=${ts}`) ||
				!supersededRows().has(ts),
		);
		expect(
			notApplied.length,
			`${notApplied.length} of ${rows} supersede writes never landed: ${notApplied.slice(0, 5).join(", ")}`,
		).toBe(0);

		// Then the appender: two read-modify-writers plus an appender is the
		// pre-fix shape that lost 40 of 80 rows.
		const appended = reportLines(join(root, "racer-c.reported")).map((l) =>
			l.trim(),
		);
		const now = readFileSync(store(), "utf8");
		const lost = appended.filter((ts) => !now.includes(`ts=${ts}`));
		expect(
			lost.length,
			`${lost.length} of ${appended.length} appended rows were overwritten by another session's rewrite: ${lost.slice(0, 5).join(", ")}`,
		).toBe(0);
		expect(appended.length).toBe(40);
	});
});

describe("a prune sweep while another session is appending", () => {
	test("prune removes exactly its matches and swallows no concurrent append", async () => {
		// Eight scopes prune on a heavy day file: each prune is one
		// snapshot→publish window, and eight windows is the net.
		const seeded = seedScopes(200, [
			["tgt-a", 40],
			["tgt-b", 40],
			["tgt-c", 40],
			["tgt-d", 40],
			["tgt-e", 40],
			["tgt-f", 40],
			["tgt-g", 40],
			["tgt-h", 40],
			["keepme", 5700],
		]);
		const writers = [spawnRacer("racer-d1", 50), spawnRacer("racer-d2", 50)];
		await waitForRows(writers, 6);

		for (const scope of [
			"tgt-a",
			"tgt-b",
			"tgt-c",
			"tgt-d",
			"tgt-e",
			"tgt-f",
			"tgt-g",
			"tgt-h",
		]) {
			await prune(scope, "learning", "consistency");
		}
		await finish(writers);

		// Exactly its matches are gone...
		const now = readFileSync(store(), "utf8");
		for (const scope of [
			"tgt-a",
			"tgt-b",
			"tgt-c",
			"tgt-d",
			"tgt-e",
			"tgt-f",
			"tgt-g",
			"tgt-h",
		]) {
			const left = seeded.get(scope)!.filter((ts) => now.includes(`ts=${ts}`));
			expect(left.length, `${left.length} ${scope} rows survived the prune`).toBe(0);
		}
		// ...exactly the non-matches remain...
		const keptMissing = seeded
			.get("keepme")!
			.filter((ts) => !now.includes(`ts=${ts}`));
		expect(
			keptMissing.length,
			`${keptMissing.length} untargeted rows vanished from the store`,
		).toBe(0);
		// ...and nothing the other sessions were promised landed nowhere.
		const { lost, reported } = lostRows(writers);
		expect(
			lost.length,
			`${lost.length} of ${reported} appended rows are in neither the store nor any snapshot: ${lost.slice(0, 5).join(", ")}`,
		).toBe(0);
		expect(reported).toBe(100);
	});
});

describe("the viewer deleting and editing while another session writes", () => {
	test("each mutation applies, and no row the writer was told it remembered is lost", async () => {
		const seeded = seedScopes(200, [["consistency", 6000]]).get("consistency")!;
		const writers = [spawnRacer("racer-e1", 50), spawnRacer("racer-e2", 50)];
		await waitForRows(writers, 6);

		// Ten viewer mutations: alternating delete and edit over the day file
		// the writer is appending to. These are the exact requests the viewer
		// makes.
		const deleted = seeded.slice(0, 5);
		const edited = seeded.slice(5, 10);
		for (const ts of deleted) {
			expect(await postApi("/api/delete", { ts, reason: "consistency" })).toBe(200);
		}
		for (const ts of edited) {
			expect(
				await postApi("/api/edit", {
					ts,
					type: "learning",
					scope: "consistency",
					content: `EDIT-MARK-${ts} applied through the viewer`,
					reason: "consistency",
				}),
			).toBe(200);
		}
		await finish(writers);

		const now = readFileSync(store(), "utf8");
		for (const ts of deleted) {
			expect(now.includes(`ts=${ts}`), `${ts} survived the viewer delete`).toBe(false);
		}
		for (const ts of edited) {
			expect(
				now.includes(`EDIT-MARK-${ts}`),
				`edit of ${ts} never reached the store`,
			).toBe(true);
		}
		// The writer's promise: its rows are in the store or recoverable, never
		// in neither. (The deleted rows are in a pre-mutation snapshot.)
		const { lost, reported } = lostRows(writers);
		expect(
			lost.length,
			`${lost.length} of ${reported} appended rows are in neither the store nor any snapshot: ${lost.slice(0, 5).join(", ")}`,
		).toBe(0);
		expect(reported).toBe(100);
	});
});

describe("restore in check and merge mode while sessions write", () => {
	test("check refuses a diverged store and changes nothing", async () => {
		const seeded = seedScopes(200, [["consistency", 6000]]).get("consistency")!;
		const [snapPath] = await snapshotFiles([store()]);
		// Diverge the live store on purpose: rows the snapshot still has but the
		// store no longer does. Check must leave them gone — a check that wrote
		// anything here would resurrect them.
		const diverged = seeded.slice(0, 40);
		dropRows(diverged);

		const writers = [spawnRacer("racer-f1", 50), spawnRacer("racer-f2", 50)];
		await waitForRows(writers, 6);
		for (let i = 0; i < 3; i++) {
			await restoreSnapshot(snapPath, memoryRoot(), "check");
		}
		await finish(writers);

		const now = readFileSync(store(), "utf8");
		const resurrected = diverged.filter((ts) => now.includes(`ts=${ts}`));
		expect(
			resurrected.length,
			`check mode wrote ${resurrected.length} rows back that only the snapshot holds`,
		).toBe(0);
		const { lost, reported } = lostRows(writers);
		expect(
			lost.length,
			`${lost.length} of ${reported} appended rows are in neither the store nor any snapshot: ${lost.slice(0, 5).join(", ")}`,
		).toBe(0);
		expect(reported).toBe(100);
	});

	test("merge brings the snapshot back without clobbering live appends", async () => {
		const seeded = seedScopes(200, [["consistency", 6000]]).get("consistency")!;
		const [snapPath] = await snapshotFiles([store()]);
		// Merge's observable claim is the union: drop 50 rows from the store, and
		// merge must restore them while every concurrent append survives too.
		const dropped = seeded.slice(0, 50);
		dropRows(dropped);

		const writers = [spawnRacer("racer-g1", 50), spawnRacer("racer-g2", 50)];
		await waitForRows(writers, 6);
		for (let i = 0; i < 6; i++) {
			await restoreSnapshot(snapPath, memoryRoot(), "merge");
		}
		await finish(writers);

		// Assert against the live store only — merge is the mode that claims the
		// union is *in the store*, so a snapshot must not be allowed to hide a
		// clobbered append here.
		const now = readFileSync(store(), "utf8");
		const missingRestored = dropped.filter((ts) => !now.includes(`ts=${ts}`));
		expect(
			missingRestored.length,
			`${missingRestored.length} of 50 snapshot rows were not restored by merge: ${missingRestored.slice(0, 5).join(", ")}`,
		).toBe(0);
		const appended = reportLines(
			join(root, "racer-g1.reported"),
			join(root, "racer-g2.reported"),
		).map((l) => l.trim());
		const lost = appended.filter((ts) => !now.includes(`ts=${ts}`));
		expect(
			lost.length,
			`${lost.length} of ${appended.length} appended rows were clobbered by the merge publish: ${lost.slice(0, 5).join(", ")}`,
		).toBe(0);
		expect(appended.length).toBe(100);
	});
});

describe("an import landing while another session writes", () => {
	// Appends were already safe when import shipped, so this scenario is green on
	// both sides by design: it pins that import lands row-wise and can never be
	// "optimized" into a bulk publish that clobbers a live writer.
	test("imported rows and concurrently appended rows all land", async () => {
		seedScopes(150, [["consistency", 1200]]);
		const importFile = join(root, "import.jsonl");
		const importedTs = Array.from({ length: 30 }, (_, i) =>
			new Date(Date.now() + 24 * 3600_000 + i).toISOString(),
		);
		writeFileSync(
			importFile,
			[
				JSON.stringify({
					_export: EXPORT_HEADER,
					version: EXPORT_VERSION,
					exportedAt: new Date().toISOString(),
					count: importedTs.length,
				}),
				...importedTs.map((ts, i) =>
					JSON.stringify({
						ts,
						type: "learning",
						scope: "consistency",
						content: `imported row ${i} ${"z".repeat(80)}`,
						status: "open",
					}),
				),
			].join("\n") + "\n",
		);

		const writers = [spawnRacer("racer-h1", 40), spawnRacer("racer-h2", 40)];
		await waitForRows(writers, 6);
		const gateCtx: GateContext = {
			liveRoot: memoryRoot(),
			evidenceCalls: [],
			hasGateCheck: true,
		};
		const tally = await importMemories(importFile, (c) =>
			runWriteGate(c, gateCtx),
		);
		await finish(writers);

		// The write choke point assigns row identity: imported rows land with a
		// fresh ts, so the observable claim is content and count, not the
		// ts values from the file.
		const now = readFileSync(store(), "utf8");
		const landed = now
			.split("\n")
			.filter((l) => l.includes("imported row")).length;
		expect(
			landed,
			`${landed} of ${importedTs.length} imported rows landed (tally ${JSON.stringify(tally)})`,
		).toBe(importedTs.length);
		const { lost, reported } = lostRows(writers);
		expect(
			lost.length,
			`${lost.length} of ${reported} appended rows are in neither the store nor any snapshot: ${lost.slice(0, 5).join(", ")}`,
		).toBe(0);
		expect(reported).toBe(80);
	});
});

/** ts values of rows currently marked superseded in the live day file. */
function supersededRows(): Set<string> {
	const out = new Set<string>();
	for (const line of readFileSync(store(), "utf8").split("\n")) {
		const ts = line.match(/^ts=(\S+)/)?.[1];
		if (ts && / superseded_by=/.test(line)) out.add(ts);
	}
	return out;
}
