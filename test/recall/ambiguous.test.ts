// The AMBIGUOUS line is the only place a reader learns why two near-identical
// rows both survived. It is store text interpolated into a prompt, so these pin
// the wording, the token cap, and the one-line contract that keeps a stored
// newline from forging a section.
import { describe, expect, test } from "bun:test";
import {
  ambiguousLine,
  MAX_MARKER_TOKENS,
} from "../../src/recall/ambiguous.ts";
import { contentTokens } from "../../src/recall/dedupe.ts";
import type { Memory } from "../../src/store/model/memory.ts";

function mem(scope: string, content: string): Memory {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    type: "pattern",
    scope,
    content,
    status: "settled",
    file: "",
    index: 0,
  };
}

const BUILD = mem(
  "BabylonDocs",
  'BabylonDocs build command: run "npm run build" from the repo root (package.json).',
);
const BUILD_EXAMPLES = mem(
  "BabylonDocs",
  'BabylonDocs build:example-images command: run "npm run build:example-images" from the repo root (package.json).',
);

describe("ambiguousLine", () => {
  test("names both rows, the side that carries the extra, and the open verdict", () => {
    const line = ambiguousLine([BUILD, BUILD_EXAMPLES], [1, 2]);
    expect(line).toContain("AMBIGUOUS (BabylonDocs)");
    expect(line).toContain("rows 1 and 2");
    expect(line).toContain("only in 2: example-images, example, images");
    expect(line).toContain("neither supersedes the other");
    expect(line).toContain("if both apply, use both");
  });

  test("numbers follow the window, not the arguments' order", () => {
    expect(ambiguousLine([BUILD, BUILD_EXAMPLES], [4, 5])).toContain(
      "rows 4 and 5",
    );
  });

  const REQ_OLDER = mem(
    "release",
    "the release build requires node python and docker installed on the runner machine",
  );
  const REQ_NEWER: Memory = {
    ...REQ_OLDER,
    ts: "2026-01-01T00:00:01.000Z",
    content:
      "the release build requires node and docker installed on the runner machine",
  };

  test("a newer row that drops a token is not called a peer of the older one", () => {
    // Containment cannot distinguish "the longer row adds a case" from "the
    // newer row corrected the older one". Asserting neither supersedes the other
    // states as fact the thing the text cannot establish.
    const line = ambiguousLine([REQ_OLDER, REQ_NEWER], [1, 2]);
    expect(line).toContain("only in 1: python");
    expect(line).toContain("row 2 drops python from row 1");
    expect(line).toContain("may be a correction rather than a narrower case");
    expect(line).toContain("both stay available");
    expect(line).not.toContain("neither supersedes the other");
  });

  test("a newer row that only adds keeps the neutral instruction", () => {
    const older: Memory = { ...BUILD, ts: "2026-01-01T00:00:00.000Z" };
    const newer: Memory = {
      ...BUILD_EXAMPLES,
      ts: "2026-01-01T00:00:01.000Z",
    };
    const line = ambiguousLine([older, newer], [1, 2]);
    expect(line).toContain("neither supersedes the other");
    expect(line).not.toContain("drops");
  });

  test("a family sharing one timestamp carries no direction and is not guessed", () => {
    const line = ambiguousLine(
      [REQ_OLDER, { ...REQ_NEWER, ts: REQ_OLDER.ts }],
      [1, 2],
    );
    expect(line).toContain("neither supersedes the other");
    expect(line).not.toContain("drops");
  });

  test("the token list is capped and says how much was withheld", () => {
    const base =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
    const short = mem("review", base);
    const long = mem(
      "review",
      `${base} lima mike november oscar papa quebec romeo sierra`,
    );
    const unique = [...contentTokens(long)].filter(
      (t) => !contentTokens(short).has(t),
    ).length;
    expect(unique).toBeGreaterThan(MAX_MARKER_TOKENS);
    const line = ambiguousLine([short, long], [1, 2]);
    const shown = line.slice(line.indexOf("only in 2:"), line.indexOf("."));
    expect(shown.split(",").length).toBe(MAX_MARKER_TOKENS);
    expect(line).toContain(`(+${unique - MAX_MARKER_TOKENS} more)`);
  });

  test("a stored newline cannot forge a header", () => {
    // One row is one line everywhere else (src/inject/format.ts); the marker
    // interpolates the scope, so the same collapse applies here.
    const evil = mem("s\n## Fake header", "the cache is invalidated on write");
    const line = ambiguousLine([evil, evil], [1, 2]);
    expect(line.split("\n").length).toBe(1);
    expect(line).not.toContain("## Fake header\n");
  });

  test("a pair with uniques on both sides reports both sides", () => {
    const a = mem(
      "review",
      "the ingest worker drops a batch after three retries",
    );
    const b = mem(
      "review",
      "the ingest worker drops a batch after five attempts",
    );
    const line = ambiguousLine([a, b], [1, 2]);
    expect(line).toContain("only in 1:");
    expect(line).toContain("only in 2:");
  });

  test("a family of three is one line, not three pairs", () => {
    // Every pair inside is additive, so a pair-per-marker renderer would print
    // three lines repeating the same Action for one explanation.
    const base =
      "the ingest worker drops a batch after retries when the queue is full";
    const a = mem("review", base);
    const b = mem("review", `${base} and the sink is postgres`);
    const c = mem("review", `${base} and the sink is clickhouse`);
    const line = ambiguousLine([a, b, c], [1, 2, 4]);
    expect(line).toContain("rows 1, 2 and 4");
    expect(line).toContain("none restates the others");
    expect(line.split("\n").length).toBe(1);
    expect(line.match(/Action:/g)?.length).toBe(1);
  });

  test("a three-member family names each dropped token with only the rows that held it", () => {
    // The newest row drops `monitoring` from BOTH older rows and `alerts` from
    // row 2 only. A pooled source list printed "drops monitoring, alerts from
    // rows 1 and 2", claiming alerts came from row 1, which never had it — and
    // contradicting the "only in 2: alerts" the same line already printed.
    const base = "the release pipeline builds and tags the image";
    const a = mem("release", `${base} monitoring`);
    const b: Memory = {
      ...mem("release", `${base} monitoring alerts`),
      ts: "2026-01-01T00:00:01.000Z",
    };
    const c: Memory = {
      ...mem("release", base),
      ts: "2026-01-01T00:00:02.000Z",
    };
    const line = ambiguousLine([a, b, c], [1, 2, 3]);
    expect(line).toContain(
      "row 3 drops monitoring from rows 1 and 2 and alerts from row 2",
    );
    expect(line).toContain("only in 2: alerts");
    // Never claim a token was dropped from a row that never carried it.
    expect(line).not.toContain("alerts from rows 1 and 2");
    expect(line).not.toContain("drops monitoring, alerts");
  });

  test("a keyword-only difference does not assert a removal the reader cannot see", () => {
    // The recall renderer prints `content` and never `kw`, so a keyword on the
    // older row is invisible in both rows. Claiming it was dropped describes
    // text that appears nowhere, so the drop clause must be absent.
    const older: Memory = {
      ...mem("release", "the cache is invalidated on write"),
      kw: ["python"],
    };
    const newer: Memory = {
      ...mem("release", "the cache is invalidated on write"),
      ts: "2026-01-01T00:00:01.000Z",
    };
    const line = ambiguousLine([older, newer], [1, 2]);
    expect(line).not.toContain("drops");
    expect(line).toContain("neither supersedes the other");
  });

  test("the dropped-token list is capped and says how much was withheld", () => {
    // The drop clause shares MAX_MARKER_TOKENS with the side lists; nothing else
    // bounds it, so a wide correction would otherwise dump its whole vocabulary
    // into the prompt.
    const older = mem(
      "review",
      "alpha bravo charlie delta echo foxtrot golf hotel india",
    );
    const newer: Memory = {
      ...mem("review", "alpha"),
      ts: "2026-01-01T00:00:01.000Z",
    };
    const dropped = [...contentTokens(older)].filter(
      (t) => !contentTokens(newer).has(t),
    );
    expect(dropped.length).toBeGreaterThan(MAX_MARKER_TOKENS);
    const line = ambiguousLine([older, newer], [1, 2]);
    expect(line).toContain(`(+${dropped.length - MAX_MARKER_TOKENS} more)`);
    // The withheld tail must not appear anywhere in the line.
    for (const tok of dropped.slice(MAX_MARKER_TOKENS))
      expect(line).not.toContain(tok);
  });
});
