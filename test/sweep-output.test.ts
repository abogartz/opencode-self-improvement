import { expect, test } from "bun:test";
import { suiteAccounting, testOutcomes } from "../scripts/sweep-output.ts";

test("sweep witnesses keep their original file and never borrow the last file from Bun's recap", () => {
  const output = [
    "test/first.test.ts:", "(pass) controls > healthy [0.12ms]", "(fail) boundary > refuses poison [1.00ms]",
    "test\\last.test.ts:", "(skip) unmodeled invariant", "(pass) controls > healthy [2.00ms]",
    "1 tests failed:", "(fail) boundary > refuses poison [1.00ms]", " 1 fail",
  ].join("\n");
  expect(testOutcomes(output)).toEqual({
    passed: ["first.test.ts > controls > healthy", "last.test.ts > controls > healthy"],
    failed: ["first.test.ts > boundary > refuses poison"],
    skipped: ["last.test.ts > unmodeled invariant"], fileFailed: [],
  });
});

const aclTitle = "broken store directory (Windows ACL) > fails fast with the real error and never runs the writer";
const aclId = `lock.test.ts > ${aclTitle}`;
const bailout = (reason: string) => `[acl-fixture] ${JSON.stringify({ event: "not-exercised", reason })}`;
const runOutput = ["test/lock.test.ts:", `(pass) ${aclTitle} [1ms]`,
  "test/other.test.ts:", "(pass) unrelated test [2ms]", " 2 pass", " 0 fail", " 0 skip"].join("\n");

test.each(["acl-deny-failed", "denial-not-effective"])("ACL %s is a capability skip even when stdout is separate", (reason) => {
  // Logging may be in stdout, before all stderr test headers or after them.
  for (const output of [`${bailout(reason)}\n${runOutput}`, `${runOutput}\n${bailout(reason)}\n${bailout(reason)}`]) {
    const result = suiteAccounting(output);
    expect(result.passed).toEqual(["other.test.ts > unrelated test"]);
    expect(result.skipped).toEqual([aclId]);
    expect(result.capabilitySkipped).toEqual([aclId]);
    expect(result.rawCounts).toEqual({ pass: 2, fail: 0, skip: 0 });
    expect([result.pass, result.fail, result.skip]).toEqual([1, 0, 1]);
  }
});

test("an exercised ACL test and unknown diagnostics retain the runner's counts", () => {
  for (const marker of ["", bailout("unknown"), '[acl-fixture] {bad json', '[acl-fixture] null',
    '[acl-fixture] {"event":"end","phase":"acl-deny","exitCode":0}']) {
    const result = suiteAccounting(`${marker}\n${runOutput}`);
    expect(result.passed).toContain(aclId);
    expect(result.capabilitySkipped).toEqual([]);
    expect([result.pass, result.fail, result.skip]).toEqual([2, 0, 0]);
  }
});

test("bailouts never erase failures, native skips, absent identifiers, or file crashes", () => {
  const marker = bailout("acl-deny-failed");
  for (const status of ["fail", "skip"]) {
    const result = suiteAccounting(`${marker}\ntest/lock.test.ts:\n(${status}) ${aclTitle}\n 1 pass\n 1 ${status}\n`);
    expect(result.capabilitySkipped).toEqual([]);
    expect(result[status === "fail" ? "failed" : "skipped"]).toEqual([aclId]);
    expect(result.pass).toBe(1); // never subtract an unrelated passing test
  }
  const missing = suiteAccounting(`${marker}\n 1 pass\n 0 fail\n 0 skip\n`);
  expect(missing.pass).toBe(1);
  expect(missing.capabilitySkipped).toEqual([]);
  for (const failure of [`(fail) ${aclTitle}`, "(fail) lock.test.ts"]) {
    const result = suiteAccounting(`${marker}\n${runOutput}\ntest/lock.test.ts:\n${failure}\n 1 fail\n`);
    expect(result.pass).toBe(2);
    expect(result.fail).toBe(1);
    expect(result.capabilitySkipped).toEqual([]);
  }
});

test("sweep separates import failures from assertion witnesses and stops at a skip recap", () => {
  expect(testOutcomes("test/broken.test.ts:\n(fail) broken.test.ts\n1 tests skipped:\n(skip) a skipped test\n")).toEqual({
    passed: [], failed: [], skipped: [], fileFailed: ["broken.test.ts"],
  });
});
