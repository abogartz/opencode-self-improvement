// The README is the front door: what this is, how it works, where to read on.
// Depth belongs in `docs/`, and the README already links there, so a reader who
// wants the mechanism is one click away and a reader who does not is not
// wading through it.
//
// Growth here is invisible to a line count. Prose inflates inside existing
// lines, so a paragraph can gain a hundred and fifty words and the file still
// reports the same length. Every budget below is therefore a ratchet: lower it
// when you trim, and never raise it to let an addition through. Rewording is
// free; length is not.
//
// The issue-reference ceiling is existing debt, not an allowance. A sentence in
// the README has to stand on its own — a reader in `node_modules` has no
// repository to look the number up in, and a number is not an explanation.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MAX_LINES = 300;
const MAX_WORDS = 4028;
const MAX_ISSUE_REFS = 9;

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const lines = readme.split("\n").length;
const words = readme.trim().split(/\s+/).filter(Boolean).length;
const issueRefs = [...readme.matchAll(/(?<![\w/])#\d{3,}/g)].length;

describe("README stays an introduction", () => {
  test(`fits the page budget: ${lines} lines of ${MAX_LINES}`, () => {
    expect(lines).toBeLessThanOrEqual(MAX_LINES);
  });

  // The check a line count cannot make: a paragraph rewritten longer leaves the
  // line total untouched.
  test(`fits the prose budget: ${words} words of ${MAX_WORDS}`, () => {
    expect(words).toBeLessThanOrEqual(MAX_WORDS);
  });

  test(`carries no more issue references than it already does: ${issueRefs} of ${MAX_ISSUE_REFS}`, () => {
    expect(issueRefs).toBeLessThanOrEqual(MAX_ISSUE_REFS);
  });
});
