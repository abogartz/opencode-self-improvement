// Scripted scenario runner: a fresh store, the plugin on the fake host, and
// sessions whose every action is ONE awaited tool call. The schedule is the
// test source itself — no timing windows — so an ordered sequence (add X,
// update Y, forget Z) replays identically every run, on any checkout whose
// tools take these arguments.
//
// Every row a session was told it remembered is tracked; `conservation()`
// asserts none of them ended up in neither the store nor a snapshot. The
// division of labour with scenarios-consistency.test.ts: this runner covers
// ORDER determinism (functional sequences a human can read off a ticket);
// that file covers WINDOW determinism (interleavings inside one operation,
// where only real processes plus rewrite windows are honest).
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { dateStr, memoryRoot, snapshotDir } from "../../src/config.ts";
import { parseLine, type Fields } from "../../src/logfmt.ts";
import { snapshotFiles } from "../../src/memory.ts";
import { resetState, setCurrent } from "../../src/state.ts";
import { startViewer, type ViewerServer } from "../../src/viewer/server.ts";
import { loadPlugin, type LoadedPlugin } from "../harness.ts";

export interface StoreRow {
	ts: string;
	type: string;
	scope: string;
	content: string;
	status: string;
	superseded_by: string | null;
}

export interface ExpectedRow {
	type: string;
	scope: string;
	content: string;
}

export interface Session {
	sid: string;
	/** Code-touching tool result: the session engaged with the code, which is
	 *  what grounds its writes (GATE-4 behaviour grounding). */
	engage(): Promise<void>;
	/** remember, returning the ts the session was handed. Throws on a blocked
	 *  write — a scripted step that silently blocked is a scenario bug. */
	remember(args: {
		type: string;
		scope: string;
		content: string;
		status?: string;
	}): Promise<string>;
	/** memory_update; omitted query targets the newest active row of scope+type. */
	update(args: {
		scope: string;
		type: string;
		content: string;
		query?: string;
	}): Promise<string>;
	forget(args: { scope: string; type: string; reason: string }): Promise<string>;
}

export interface Scripted {
	session(sid: string): Session;
	rows(): StoreRow[];
	active(): StoreRow[];
	/** Snapshot the store now; the name is what the viewer's restore takes. */
	snapshot(): Promise<string>;
	/** The viewer's restore button: force mode, full-file publish. */
	restore(name: string): Promise<number>;
	expectActive(expected: ExpectedRow[]): void;
	/** Every ts ever handed to a session is in the store or a snapshot. */
	conservation(): void;
	cleanup(): Promise<void>;
}

function storeFile(): string {
	return join(memoryRoot(), `${dateStr()}.logfmt`);
}

function storeText(): string {
	// A fresh store has no day file until its first append: "no entries" is a
	// readable state, not an error.
	try {
		return readFileSync(storeFile(), "utf8");
	} catch {
		return "";
	}
}

function parseRows(): StoreRow[] {
	const out: StoreRow[] = [];
	for (const line of storeText().split("\n")) {
		if (!line.trim()) continue;
		const f = parseLine(line);
		if (!f) continue;
		out.push({
			ts: String(f.ts ?? ""),
			type: String(f.type ?? ""),
			scope: String(f.scope ?? ""),
			content: String(f.content ?? ""),
			status: String(f.status ?? "settled"),
			superseded_by: f.superseded_by ? String(f.superseded_by) : null,
		});
	}
	return out;
}

function snapshotCorpus(): string {
	let parts: string[] = [];
	const dir = snapshotDir();
	mkdirSync(dir, { recursive: true });
	for (const f of readdirSync(dir, { recursive: true })) {
		try {
			parts.push(readFileSync(join(dir, String(f)), "utf8"));
		} catch {
			/* a lock or temp file, not a snapshot */
		}
	}
	return parts.join("\n");
}

export async function startScripted(): Promise<Scripted> {
	resetState();
	const root = mkdtempSync(join(tmpdir(), "osi-script-"));
	process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
	process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
	mkdirSync(memoryRoot(), { recursive: true });
	const p: LoadedPlugin = await loadPlugin(process.cwd());
	const vm: ViewerServer = await startViewer(0);
	const promised: string[] = [];
	let callSeq = 0;
	const nextCall = () => `SC${++callSeq}`;

	const rows = parseRows;
	const active = () => rows().filter((r) => !r.superseded_by);

	const run = async (tool: string, args: Record<string, unknown>): Promise<string> => {
		const out = await p.tool[tool].execute(args);
		if (/blocked at GATE/i.test(out)) {
			throw new Error(`${tool} blocked: ${out}`);
		}
		return out;
	};

	const session = (sid: string): Session => ({
		sid,
		async engage() {
			await p["tool.execute.after"](
				{
					tool: "read",
					sessionID: sid,
					callID: nextCall(),
					args: { filePath: "src/scenario.ts" },
				},
				{ output: "42 lines of src/scenario.ts", metadata: {} },
			);
		},
		async remember(args) {
			const before = new Set(rows().map((r) => r.ts));
			setCurrent({ sessionID: sid, callID: nextCall(), tool: "memory_remember" });
			const out = await run("memory_remember", args);
			const fresh = rows().filter((r) => !before.has(r.ts));
			if (fresh.length === 1) {
				promised.push(fresh[0]!.ts);
				return fresh[0]!.ts;
			}
			// A collapse stores nothing new: the alias binds to the existing row
			// so scenario tables can still refer to it.
			if (/Duplicate ignored/i.test(out)) {
				const existing = active().find(
					(r) => r.scope === args.scope && r.content === args.content,
				);
				if (existing) return existing.ts;
			}
			throw new Error(
				`memory_remember stored ${fresh.length} rows for one call, expected exactly 1: ${out}`,
			);
		},
		async update(args) {
			const before = new Set(rows().map((r) => r.ts));
			setCurrent({ sessionID: sid, callID: nextCall(), tool: "memory_update" });
			await run("memory_update", args);
			const fresh = rows().filter((r) => !before.has(r.ts) && !r.superseded_by);
			if (fresh.length !== 1) {
				throw new Error(
					`memory_update landed ${fresh.length} new active rows, expected exactly 1`,
				);
			}
			promised.push(fresh[0]!.ts);
			return fresh[0]!.ts;
		},
		async forget(args) {
			setCurrent({ sessionID: sid, callID: nextCall(), tool: "memory_forget" });
			return await run("memory_forget", args);
		},
	});

	return {
		session,
		rows,
		active,
		async snapshot() {
			const [path] = await snapshotFiles([storeFile()]);
			return basename(path);
		},
		async restore(name) {
			const res = await vm.server.fetch(
				new Request(new URL("/api/restore", vm.url), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name }),
				}),
			);
			return res.status;
		},
		expectActive(expected) {
			const now = active()
				.map((r) => ({ type: r.type, scope: r.scope, content: r.content }))
				.sort((a, b) => `${a.scope}${a.content}`.localeCompare(`${b.scope}${b.content}`));
			const want = [...expected].sort((a, b) =>
				`${a.scope}${a.content}`.localeCompare(`${b.scope}${b.content}`),
			);
			expect(now, `active store rows:\n${JSON.stringify(now, null, 1)}`).toEqual(want);
		},
		conservation() {
			const corpus = storeText() + "\n" + snapshotCorpus();
			const lost = promised.filter((ts) => !corpus.includes(`ts=${ts}`));
			expect(
				lost.length,
				`${lost.length} of ${promised.length} promised rows are in neither the store nor any snapshot: ${lost.slice(0, 5).join(", ")}`,
			).toBe(0);
		},
		async cleanup() {
			vm.server.stop();
			await p.cleanup();
			delete process.env.OPENCODE_MEMORY_DIR;
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		},
	};
}
