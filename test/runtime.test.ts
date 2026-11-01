// The Bun version floor: pure parser + startup warning text. The plugin runs
// on the Bun embedded in opencode, and fs failure modes differ between Bun
// versions, so a below-floor host gets ONE warn (never a block) at setup.
// No fs, no Bun global here — the version string is injected, so the exact
// same suite passes on every bun binary that runs `bun test`.
import { describe, expect, test } from "bun:test";
import { MIN_BUN, bunFloorWarning, parseBunVersion } from "../src/core/runtime.ts";

// Unwraps a warning we EXPECT to exist; a null result becomes a string that
// fails the toContain checks below, so this never hides a bug (and avoids
// non-null assertions).
const warned = (versionString: string | undefined): string =>
  bunFloorWarning(versionString) ?? "<<no warning>>";

describe("parseBunVersion", () => {
  test("parses a plain semver triple", () => {
    expect(parseBunVersion("1.4.4")).toEqual([1, 4, 4]);
  });

  test("tolerates a v prefix and a canary suffix", () => {
    expect(parseBunVersion("v1.4.4-canary")).toEqual([1, 4, 4]);
  });

  test("tolerates the bun release-tag form", () => {
    expect(parseBunVersion("bun-v1.3.10")).toEqual([1, 3, 10]);
  });

  test("returns null for junk or a version without a patch component", () => {
    expect(parseBunVersion("")).toBeNull();
    expect(parseBunVersion("not a version")).toBeNull();
    expect(parseBunVersion("1.3")).toBeNull();
  });
});

describe("bunFloorWarning", () => {
  test("the floor is the documented [1, 3, 0] lower bound", () => {
    expect(MIN_BUN).toEqual([1, 3, 0]);
  });

  test("versions at or above the floor stay silent, including the two this repo runs on", () => {
    expect(bunFloorWarning("1.3.0")).toBeNull(); // floor itself is inclusive
    expect(bunFloorWarning("1.3.10")).toBeNull(); // system bun
    expect(bunFloorWarning("1.4.4")).toBeNull(); // bun embedded in current opencode
    expect(bunFloorWarning("2.0.1")).toBeNull(); // future majors: not below, silent
  });

  test("comparison is numeric, not lexical: 1.10.0 passes the 1.3.0 floor", () => {
    expect(bunFloorWarning("1.10.0")).toBeNull();
    expect(bunFloorWarning("1.12.9")).toBeNull();
  });

  test("a version below the floor warns, naming plugin, version and floor", () => {
    const w = warned("1.2.40");
    expect(w.startsWith("[opencode-self-improvement]")).toBe(true);
    expect(w).toContain("1.2.40");
    expect(w).toContain("1.3.0");
    expect(w).toContain("memory features may misbehave");
    expect(w.split("\n")).toHaveLength(1); // one line, one sentence
  });

  test("a missing version (non-Bun host) warns like an unknown one", () => {
    const w = warned(undefined);
    expect(w.startsWith("[opencode-self-improvement]")).toBe(true);
    expect(w).toContain("1.3.0");
    expect(w).toContain("memory features may misbehave");
    expect(w.split("\n")).toHaveLength(1);
  });

  test("an unparseable version warns and quotes what it saw", () => {
    const w = warned("1.3-canary");
    expect(w).toContain('"1.3-canary"'); // quoted so empty/odd strings stay visible
    expect(w).toContain("1.3.0");
    expect(w.split("\n")).toHaveLength(1);
  });
});
