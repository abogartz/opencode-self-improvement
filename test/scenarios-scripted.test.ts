// Scripted scenario suite: ordered memory actions against a fresh store with a
// fake host and fake LLM, compared to an expected result table. Every step is
// one awaited tool call, so the event order IS the schedule — these replay
// identically on every run, and a regression only needs the events in the
// wrong (or right) order to fire.
//
// Every scenario ends in two assertions: the exact table of active rows, and
// conservation — each row any session was told it remembered is in the store
// or in a snapshot. Which mode is red on the pre-lock commit belongs to
// scenarios-consistency.test.ts (interleavings inside one operation); these
// pin functional composition, so expectations are current behavior, and a
// deliberate expectation change is the review signal when semantics change.
import { afterEach, describe, expect, test } from "bun:test";
import { runWriteGate, type GateContext } from "../src/gates.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryRoot } from "../src/config.ts";
import {
	EXPORT_HEADER,
	EXPORT_VERSION,
	importMemories,
} from "../src/portable.ts";
import { startScripted, type Scripted } from "./helpers/scripted.ts";

let s: Scripted;

afterEach(async () => {
	await s?.cleanup();
});

describe("the basic lifecycle: add, update, forget", () => {
	test("the store ends holding exactly the surviving row, and everything promised is recoverable", async () => {
		s = await startScripted();
		const s1 = s.session("s1");
		await s1.engage();

		const x = await s1.remember({
			type: "learning",
			scope: "build",
			content: "bun test runs the suite from the repo root",
		});
		await s1.remember({
			type: "learning",
			scope: "api",
			content: "the viewer serves the store over loopback only",
		});
		const y2 = await s1.update({
			scope: "api",
			type: "learning",
			content: "the viewer binds 127.0.0.1 unless explicitly widened",
		});

		// update targets the newest active row of scope+type: exactly one new
		// active row exists for api, and the row it replaced is marked, not gone.
		const replaced = s.rows().find((r) => r.ts !== y2 && r.scope === "api");
		expect(replaced?.ts, "no prior api row was superseded").toBeTruthy();
		expect(replaced?.superseded_by, "the old api row is still active after update").toBeTruthy();

		await s1.forget({ scope: "build", type: "learning", reason: "scenario" });
		expect(s.active().some((r) => r.ts === x), "forgot row is still active").toBe(false);

		s.expectActive([
			{
				type: "learning",
				scope: "api",
				content: "the viewer binds 127.0.0.1 unless explicitly widened",
			},
		]);
		s.conservation();
	});
});

describe("a duplicate remember", () => {
	test("collapse stores one row and the alias binds to the existing one", async () => {
		s = await startScripted();
		const s1 = s.session("s1");
		await s1.engage();
		const first = await s1.remember({
			type: "pattern",
			scope: "style",
			content: "comments state intent, never history",
		});
		const second = await s1.remember({
			type: "pattern",
			scope: "style",
			content: "comments state intent, never history",
		});

		expect(second).toBe(first);
		s.expectActive([
			{ type: "pattern", scope: "style", content: "comments state intent, never history" },
		]);
		s.conservation();
	});
});

describe("two sessions on one store, step by step", () => {
	test("each session acts as its own grounding and neither sees the other's identity", async () => {
		s = await startScripted();
		const s1 = s.session("s1");
		const s2 = s.session("s2");
		await s1.engage();
		await s2.engage();

		const a = await s1.remember({
			type: "learning",
			scope: "build",
			content: "the typecheck gate is tsc --noEmit",
		});
		const b = await s2.remember({
			type: "learning",
			scope: "build",
			content: "biome check is the lint gate",
		});
		const a2 = await s1.update({
			scope: "build",
			type: "learning",
			query: a,
			content: "the typecheck gate is bun run typecheck (tsc via bun x)",
		});

		// session-2's row is untouched; session-1's targeted update superseded
		// exactly its own prior row.
		expect(s.rows().find((r) => r.ts === b)?.superseded_by).toBeNull();
		expect(s.rows().find((r) => r.ts === a)?.superseded_by).toBe(a2);

		s.expectActive([
			{
				type: "learning",
				scope: "build",
				content: "the typecheck gate is bun run typecheck (tsc via bun x)",
			},
			{ type: "learning", scope: "build", content: "biome check is the lint gate" },
		]);
		s.conservation();
	});
});

describe("a force restore between two remembers", () => {
	test("the store reverts to the snapshot while the newer row stays recoverable", async () => {
		s = await startScripted();
		const s1 = s.session("s1");
		await s1.engage();

		await s1.remember({
			type: "learning",
			scope: "cache",
			content: "the epoch block is frozen once per session",
		});
		const snap = await s.snapshot();
		const newer = await s1.remember({
			type: "learning",
			scope: "cache",
			content: "busting the epoch invalidates the prompt cache",
		});

		expect(await s.restore(snap)).toBe(200);
		expect(s.active().some((r) => r.ts === newer), "force restore kept the newer row active").toBe(false);
		s.expectActive([
			{
				type: "learning",
				scope: "cache",
				content: "the epoch block is frozen once per session",
			},
		]);
		// The whole promise of a force restore: the row it rolled back is in a
		// snapshot, never in neither place.
		s.conservation();
	});
});

describe("a forgotten value re-entering through import", () => {
	// #35 FLIPPED this table. It used to pin the opposite policy: nothing was
	// keyed on a rejected or forgotten value, so re-ingestion stored it again as
	// a fresh row, and the comment here said the tombstone work would flip it to
	// "row absent, tally blocked". That is what now happens — the rejection is
	// keyed on the VALUE, so a replay through import is refused even though the
	// row that held it is gone and its `ts` no longer exists anywhere.
	test("import refuses the forgotten value instead of re-storing it (#35)", async () => {
		s = await startScripted();
		const s1 = s.session("s1");
		await s1.engage();
		const forgotten = "the release train needs a green CI run before tagging";
		await s1.remember({ type: "learning", scope: "release", content: forgotten });
		await s1.forget({ scope: "release", type: "learning", reason: "scenario" });
		s.expectActive([]);

		const file = join(memoryRoot(), "reingest.jsonl");
		writeFileSync(
			file,
			[
				JSON.stringify({
					_export: EXPORT_HEADER,
					version: EXPORT_VERSION,
					exportedAt: new Date().toISOString(),
					count: 1,
				}),
				JSON.stringify({
					ts: new Date(Date.now() + 24 * 3600_000).toISOString(),
					type: "learning",
					scope: "release",
					content: forgotten,
					status: "open",
				}),
			].join("\n") + "\n",
		);
		const gateCtx: GateContext = {
			liveRoot: memoryRoot(),
			evidenceCalls: [],
			hasGateCheck: true,
		};
		const tally = await importMemories(file, (c) => runWriteGate(c, gateCtx));

		expect(tally.promoted).toBe(0);
		expect(tally.blocked).toBe(1);
		s.expectActive([]);
		s.conservation();
	});
});
