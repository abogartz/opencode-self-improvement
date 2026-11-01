// #44 in the real wiring: memory_status must carry the store's own numbers, and
// they must agree with what is actually on disk.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { recordCaptureLag } from "../src/evidence/record.ts";
import { loadPlugin } from "./harness.ts";
import { resetState } from "../src/core/state.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-metrics-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  mkdirSync(memoryRoot(), { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("self-metrics through the tool (#44)", () => {
  test("the report sizes the store, states growth, and names its capture lag", async () => {
    const p = await loadPlugin(process.cwd());
    await appendMemory({
      type: "pattern",
      scope: "build",
      content: "run bun test from the repo root to execute the whole suite before pushing",
      status: "settled",
    });
    await appendMemory({
      type: "learning",
      scope: "api",
      content: "the ingest endpoint returns 202 and reconciles later, never 200 inline",
      status: "open",
    });
    await recordCaptureLag("ses_x", 4200, "candidates");

    const rep = await p.tools.memory_status!.execute({});
    // Every active row is priced, in bytes, and the average follows from it.
    expect(rep.content).toContain(" B total · ");
    expect(rep.content).toMatch(/\d+ B total · \d+ B per row/);
    // Growth is stated over the trailing window.
    expect(rep.content).toContain("rows/day (30d)");
    // Capture latency comes from evidence, in a unit a human reads.
    expect(rep.content).toContain("capture lag p50 4.2 s / p95 4.2 s");
    // Nothing has been recalled in this root: the dead weight is the store.
    expect(rep.content).toContain("never retrieved 2 (100%)");
  });
});
