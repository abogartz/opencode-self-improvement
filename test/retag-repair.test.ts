// #378 review (WhollyMindless): the #375 re-tag repair must not leave the
// unsafe original live. Two ways it did:
// (a) an interrupted repair leaves a quarantined twin; the retry's gate write
//     COLLAPSED into that twin and the old code counted it as blocked, so the
//     original stayed unquarantined forever;
// (b) markSuperseded REJECTS (lock contention) and the throw escaped the whole
//     repair instead of reporting a durable partial.
// The mock below is process-wide (Bun caveat, see lock-absent-holder.test.ts):
// it delegates to the real module unless a test arms a ts, and afterEach
// empties the armed set.
import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { removeStore } from "./helpers/remove-store.ts";

const realModule = await import("../src/store/files/supersede.ts");
const real = { ...realModule };
type BatchEntry = {
  ts: string;
  fields: import("../src/store/files/supersede.ts").SupersedeFields;
};

const throwOn = new Set<string>();

mock.module("../src/store/files/supersede.ts", () => ({
  ...real,
  markManySupersededReport: async (
    entries: BatchEntry[],
    durable?: string[],
  ) => {
    for (const e of entries) {
      if (throwOn.delete(e.ts))
        throw new Error("store lock refused (simulated contention)");
    }
    return real.markManySupersededReport(entries, durable);
  },
}));

const { retagQuarantinedRows } = await import("../src/init/retag.ts");
const { loadAll } = await import("../src/store/files/load.ts");
const { setRepoScope } = await import("../src/identity/repokey.ts");
type GateContext = import("../src/gate/gate.ts").GateContext;

const POISON =
  "The bootstrap script calls eval(config) before the app starts, so env setup runs first.";
const TWIN_TAGS = ["quarantine", "quarantine:dynamic_execute"];

let root: string;
let liveRoot: string;

function seedAt(ts: string, extra: Record<string, unknown> = {}): void {
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${formatLine({
      ts,
      type: "learning",
      scope: "bootstrap",
      content: POISON,
      ...extra,
    })}\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-retag-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  setRepoScope(null);
  throwOn.clear();
});

afterEach(() => {
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

const ctx = (): GateContext => ({
  liveRoot,
  evidenceCalls: [],
  hasGateCheck: true,
  trusted: true,
});

describe("#378 re-tag repair", () => {
  test("clean repair: original retires under its quarantined twin", async () => {
    seedAt("2026-11-01T10:00:00.000Z");
    const out = await retagQuarantinedRows(ctx());
    expect(out.retagged).toBe(1);
    expect(out.blocked).toBe(0);
    expect(out.partial).toBe(0);
    const rows = await loadAll();
    const original = rows.find((r) => r.ts === "2026-11-01T10:00:00.000Z");
    expect(original?.superseded_by).toBeTruthy();
    const active = rows.filter((r) => !r.superseded_by);
    expect(active.length).toBe(1);
    expect(active[0]?.tags).toContain("quarantine");
  });

  test("finding (a): a quarantined twin from an interrupted repair finishes the job", async () => {
    // The interrupted repair: the twin is durable, the retirement was lost.
    seedAt("2026-11-01T10:00:00.000Z");
    seedAt("2026-11-01T10:00:01.000Z", {
      tags: TWIN_TAGS,
      superseded_by: undefined,
    });
    const out = await retagQuarantinedRows(ctx());
    // Old code: retagged=0, blocked=1, and every retry the same — the
    // untagged original stayed injectable forever.
    expect(out.retagged).toBe(1);
    expect(out.blocked).toBe(0);
    const rows = await loadAll();
    const original = rows.find((r) => r.ts === "2026-11-01T10:00:00.000Z");
    expect(original?.superseded_by).toBe("2026-11-01T10:00:01.000Z");
    const active = rows.filter((r) => !r.superseded_by);
    expect(active.length).toBe(1);
    expect(active[0]?.ts).toBe("2026-11-01T10:00:01.000Z");
  });

  test("finding (b): a rejecting retirement reports partial, and the retry finishes", async () => {
    seedAt("2026-11-01T10:00:00.000Z");
    throwOn.add("2026-11-01T10:00:00.000Z");
    // Old code: the throw escaped retagQuarantinedRows and memory_init
    // reported nothing about the twin that WAS written.
    const out = await retagQuarantinedRows(ctx());
    expect(out.retagged).toBe(0);
    expect(out.partial).toBe(1);
    expect(out.failures.length).toBe(1);
    expect(out.failures[0]).toContain("simulated contention");
    // The unsafe state is real after this run: twin durable, original live.
    const mid = await loadAll();
    expect(mid.filter((r) => !r.superseded_by).length).toBe(2);
    // Retry with no contention: the collapse path retires the original.
    const retry = await retagQuarantinedRows(ctx());
    expect(retry.retagged).toBe(1);
    const rows = await loadAll();
    const original = rows.find((r) => r.ts === "2026-11-01T10:00:00.000Z");
    expect(original?.superseded_by).toBeTruthy();
    expect(rows.filter((r) => !r.superseded_by).length).toBe(1);
  });

  test("a clean row is scanned and left untouched", async () => {
    seedAt("2026-11-01T10:00:00.000Z", { content: "Tests run bun test." });
    const out = await retagQuarantinedRows(ctx());
    expect(out.scanned).toBe(1);
    expect(out.retagged).toBe(0);
    expect(out.blocked).toBe(0);
    const rows = await loadAll();
    expect(rows.length).toBe(1);
    expect(rows[0]?.superseded_by).toBeUndefined();
  });
});
