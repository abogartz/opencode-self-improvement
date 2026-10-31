import { expect, test } from "bun:test";
import { testOutcomes } from "../scripts/sweep-output.ts";

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

test("sweep separates import failures from assertion witnesses and stops at a skip recap", () => {
  expect(testOutcomes("test/broken.test.ts:\n(fail) broken.test.ts\n1 tests skipped:\n(skip) a skipped test\n")).toEqual({
    passed: [], failed: [], skipped: [], fileFailed: ["broken.test.ts"],
  });
});
