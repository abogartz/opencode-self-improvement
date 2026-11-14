// #208 pins: GATE-2 evidence and promoted.supersedes must attribute only the
// supersessions the call actually performed. When a concurrent session (or the
// viewer) retires a planned row between the gate's scope read and the batch
// publish, the batch skips that row (it re-reads under the lock), so `marked`
// omits it — but the audit loops used to replay the whole PLAN, naming the
// out-of-band row with THIS chain and reason. memory_evidence then blamed a
// retirement on the wrong chain. These pins drive the interleaving
// deterministically through a module wrapper, so no test races a wall clock.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { loadAll } from "../src/store/files/load.ts";
import type { SupersedeFields } from "../src/store/files/supersede.ts";
import { resetState, setCurrent } from "../src/core/state.ts";
import { rememberSessionDir } from "../src/identity/repokey.ts";
import { readEvidenceLog as evidence, ev, field } from "./helpers/logfmt.ts";
import { removeStore } from "./helpers/remove-store.ts";

// Captured BEFORE the mock below: the wrapper delegates to the genuine
// implementation, and the simulated other session retires rows through the
// real markSuperseded — a local binding inside supersede.ts, so it never
// re-enters the wrapper. The references are copied into a plain object
// because mock.module overwrites the namespace object in place.
const realModule = await import("../src/store/files/supersede.ts");
const real = { ...realModule };
type BatchEntry = { ts: string; fields: SupersedeFields };

// ts values armed by the running test: the next batch naming one of them
// first loses that row to the simulated other session — landing between the
// gate's scan and the batch publish — and then runs for real. Everything
// else passes straight through. NOTE (same caveat as lock-absent-holder):
// mock.module is process-wide in Bun and never uninstalled; the armed set is
// the only state, and afterEach empties it.
const intercept = new Set<string>();

mock.module("../src/store/files/supersede.ts", () => ({
  ...real,
  markManySupersededReport: async (
    entries: BatchEntry[],
    durable?: string[],
  ) => {
    for (const e of entries) {
      if (intercept.delete(e.ts)) {
        await real.markSuperseded(e.ts, {
          superseded_by: "OTHER-SESSION",
          reason: "drift",
        });
      }
    }
    return real.markManySupersededReport(entries, durable);
  },
}));

const { runWriteGate } = await import("../src/gate/gate.ts");
type GateContext = import("../src/gate/gate.ts").GateContext;

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-attr-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  intercept.clear();
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

function seed(
  type: string,
  scope: string,
  content: string,
  ts = new Date().toISOString(),
): string {
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, formatLine({ ts, type, scope, content }) + "\n");
  return ts;
}

function writeCanonical(fields: Record<string, string>): void {
  mkdirSync(memoryRoot(), { recursive: true });
  appendFileSync(
    join(memoryRoot(), "canonical.logfmt"),
    formatLine(fields) + "\n",
  );
}

function ctx(sid: string): GateContext {
  rememberSessionDir(sid, liveRoot);
  return {
    liveRoot,
    evidenceCalls: [],
    hasGateCheck: true,
  };
}

describe("#208 — gate evidence attributes only supersessions the call performed", () => {
  test("drift interleaving: an out-of-band retirement keeps the other session's pointer", async () => {
    writeFileSync(
      join(liveRoot, "table_manager.ts"),
      "export function save(config, opts) {\n  return [config, opts];\n}\n",
    );
    const M1 = seed(
      "pattern",
      "ctl",
      "use table_manager.save(opts)",
      "2026-01-01T00:00:00.000Z",
    );
    const M2 = seed(
      "pattern",
      "ctl",
      "call table_manager.save(opts) before persist",
      "2026-01-02T00:00:00.000Z",
    );
    intercept.add(M2);

    const sid = "p208-drift";
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      {
        type: "pattern",
        scope: "ctl",
        content: "use table_manager.save(config, opts)",
      },
      ctx(sid),
    );
    expect(outcome.action).toBe("promoted");

    const lines = evidence();
    // One superseded_by line, for the row THIS call retired — not the plan.
    const sbs = ev(lines, "superseded_by");
    expect(sbs.length).toBe(1);
    expect(field(sbs[0], "mem")).toBe(M1);
    expect(field(sbs[0], "reason")).toBe("drift");
    // promoted.supersedes names the marked row, never the skipped one.
    expect(field(ev(lines, "write_promoted")[0], "supersedes")).toBe(M1);

    const durable = await loadAll();
    expect(durable.find((m) => m.ts === M1)?.superseded_by).toBeTruthy();
    // The out-of-band row keeps the other session's pointer untouched.
    expect(durable.find((m) => m.ts === M2)?.superseded_by).toBe(
      "OTHER-SESSION",
    );
  });

  test("canonical interleaving: the skipped first row is not claimed by this chain", async () => {
    const M1 = seed(
      "decision",
      "backend",
      "use Express for API routing",
      "2026-01-01T00:00:00.000Z",
    );
    const M2 = seed(
      "decision",
      "backend",
      "use Hapi for API routing",
      "2026-01-02T00:00:00.000Z",
    );
    writeCanonical({
      ts: "REG-1",
      type: "canonical",
      entity: "API routing",
      value: "Fastify",
      scope: "backend",
      source: "AGENTS.md:42",
      review: "approved",
    });
    // Retire the FIRST planned row out of band: the buggy loop set
    // promoted.supersedes from the plan head, so this placement makes the
    // unmarked row the one the audit would claim.
    intercept.add(M1);

    const sid = "p208-canon";
    setCurrent({ sessionID: sid, callID: "C1", tool: "memory_remember" });
    const outcome = await runWriteGate(
      {
        type: "decision",
        scope: "backend",
        content: "use Fastify for API routing",
      },
      ctx(sid),
    );
    expect(outcome.action).toBe("promoted");

    const lines = evidence();
    const sbs = ev(lines, "superseded_by");
    expect(sbs.length).toBe(1);
    expect(field(sbs[0], "mem")).toBe(M2);
    expect(field(sbs[0], "reason")).toBe("canonical");
    expect(field(sbs[0], "to")).toBe("Fastify");
    expect(field(ev(lines, "write_promoted")[0], "supersedes")).toBe(M2);

    const durable = await loadAll();
    expect(durable.find((m) => m.ts === M1)?.superseded_by).toBe(
      "OTHER-SESSION",
    );
    expect(durable.find((m) => m.ts === M2)?.superseded_by).toBeTruthy();
  });
});
