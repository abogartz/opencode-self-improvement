// The case bank, run where CI can actually see it.
//
// The bank lives in `bench/fixtures/availability-cases.ts` and the policy bench
// reports it. That is not enough: `.github/workflows/ci.yml` runs no bench at all,
// so a verdict that drifted would fail nothing but a command nobody is required to
// type. This file is the same 21 pairs, asserted, in the suite CI does run — 800 ms
// for all of them, measured.
//
// One repo per case, because sharing one tree would let a candidate match a
// DIFFERENT case's line and report a verdict for the wrong reason.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availabilityIndex } from "../src/capture/available.ts";
import { AVAILABILITY_CASES } from "../bench/fixtures/availability-cases.ts";

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "osi-case-bank-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** A tracked tree is the only input: the index reads `git ls-files`. */
function repoFor(name: string, tree: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), tree);
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" });
  return dir;
}

// Asserted as one case per entry, so a failure names the case AND the review round
// that found it. A single aggregate assertion would report "19/21" and leave the
// reader to find which veto moved.
for (const c of AVAILABILITY_CASES) {
  test(`availability: ${c.id}`, () => {
    const verdict = availabilityIndex(repoFor(c.id, c.tree)).check(c.candidate);
    expect(
      verdict !== null,
      `${c.id}: ${c.source} — expected ${c.expectTag ? "a restatable verdict" : "no verdict (keep the row)"}, got ${verdict ? `${verdict.reason} matched [${verdict.matched}]` : "none"}`,
    ).toBe(c.expectTag);
  });
}

// The bank's own shape. A bank of only "must tag" cases passes on a check that
// tags everything; one of only "must not" passes on a check that tags nothing.
test("the case bank can say both things", () => {
  const tags = AVAILABILITY_CASES.filter((c) => c.expectTag).length;
  const keeps = AVAILABILITY_CASES.filter((c) => !c.expectTag).length;
  expect(AVAILABILITY_CASES.length).toBeGreaterThanOrEqual(12);
  expect(tags).toBeGreaterThanOrEqual(3);
  expect(keeps).toBeGreaterThanOrEqual(6);
  expect(new Set(AVAILABILITY_CASES.map((c) => c.id)).size).toBe(
    AVAILABILITY_CASES.length,
  );
});
