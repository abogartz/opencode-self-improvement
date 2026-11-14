// The pre-push hook must not promise CI enforcement on a push (#236):
// ci.yml triggers on pull_request and workflow_dispatch only, so a direct
// push with SKIP_GATE=1 runs no CI at all.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeStore } from "./helpers/remove-store.ts";

const hookPath = join(import.meta.dir, "..", ".githooks", "pre-push");

// A clause asserting that CI enforces, catches, covers, guarantees or checks
// a push is the false promise, whatever its exact wording. Matching is per
// clause, not per line, so an unrelated negation elsewhere on the line
// ("no local checks ran, but CI will still enforce everything") cannot cancel
// the claim, and the verb list covers rewordings that drop the word
// "enforce". Matching the claim (not one sentence) means a reworded hook
// cannot reintroduce it.
const CLAIM =
  /\bCI\b[^;,.:—–]*\b(enforce|catch|cover|guarantee|verif|check)|\b(enforce|catch|cover|guarantee|verif|check)[^;,.:—–]*\bCI\b/i;
const NEGATED = /\b(no|not|never|nothing|neither|without)\b/i;

function falseCiClaims(text: string): string[] {
  return text
    .split("\n")
    .filter((line) =>
      line
        .split(/[;,.:—–]/)
        .some((clause) => CLAIM.test(clause) && !NEGATED.test(clause)),
    );
}

test("hook text makes no un-negated CI-enforcement claim", () => {
  expect(falseCiClaims(readFileSync(hookPath, "utf8"))).toEqual([]);
});

test("hook text states the true consequence of skipping the gate", () => {
  const text = readFileSync(hookPath, "utf8");
  expect(text).toMatch(/no CI/i);
  expect(text).toMatch(/pull request/i);
});

// The printed message is what a developer actually reads, so it is checked
// positively too: a truthful header comment alone cannot satisfy these
// assertions while the echo re-promises enforcement.
test.skipIf(!Bun.which("sh"))(
  "skip path exits 0, mentions SKIP_GATE, states the true consequence, promises nothing about CI",
  () => {
    const cwd = mkdtempSync(join(tmpdir(), "osi236-hook-"));
    try {
      const proc = Bun.spawnSync(["sh", hookPath], {
        cwd,
        env: { SKIP_GATE: "1", PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(0);
      const out = proc.stdout.toString();
      expect(out).toContain("SKIP_GATE");
      expect(out).toMatch(/no CI/i);
      expect(out).toMatch(/pull request/i);
      expect(falseCiClaims(out)).toEqual([]);
    } finally {
      removeStore(cwd);
    }
  },
);

test("non-skip path is text-pinned to run the merge gate and exit 1 (not executed)", () => {
  const text = readFileSync(hookPath, "utf8");
  expect(text).toMatch(/bun run gate/);
  expect(text).toMatch(/exit 1/);
});
