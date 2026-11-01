// Memory attribution: the pure join between the refs an injected memory asserts
// and the session's later tool calls. No harness, no I/O — the whole point is
// that this is deterministic and unit-testable.
import { describe, expect, test } from "bun:test";
import {
  attributeSession,
  deriveMemoryRefs,
  extractCommandRefs,
  type CallLike,
} from "../src/inject/attribution.ts";
import type { Memory } from "../src/store/model/memory.ts";

const mem = (content: string): Memory => ({ content } as unknown as Memory);
const call = (tool: string, arg: string, ts: string): CallLike => ({ tool, arg, ts });

describe("extractCommandRefs", () => {
  test("takes backticked commands that start with a known bin", () => {
    const cmds = extractCommandRefs("run `bun run gate` then `bunx tsc --noEmit`");
    expect(cmds).toContain("bun run gate");
    expect(cmds).toContain("bunx tsc --noEmit");
  });
  test("ignores prose and bare paths (no bin, no args)", () => {
    expect(extractCommandRefs("edit `src/gates.ts` and read `the store`")).toEqual([]);
  });
  test("dedupes", () => {
    expect(extractCommandRefs("`bun test` and again `bun test`")).toEqual(["bun test"]);
  });
});

describe("deriveMemoryRefs", () => {
  test("collects code paths and commands the memories assert", () => {
    const refs = deriveMemoryRefs([
      mem("the gate is `bun run gate`; see src/gates.ts and src/status.ts"),
      mem("typecheck via `bunx tsc --noEmit` in src/attribution.ts"),
    ]);
    expect(refs.commands).toContain("bun run gate");
    expect(refs.commands).toContain("bunx tsc --noEmit");
    expect(refs.paths).toContain("src/gates.ts");
    expect(refs.paths).toContain("src/status.ts");
    expect(refs.paths).toContain("src/attribution.ts");
  });
  test("empty memories yield empty refs", () => {
    expect(deriveMemoryRefs([])).toEqual({ paths: [], commands: [] });
  });
});

describe("attributeSession — Tier A (command reuse, measured)", () => {
  const refs = { paths: [], commands: ["bun run gate"] };

  test("credits a save when a remembered command runs with no prior lookup", () => {
    const a = attributeSession([call("bash", "bun run gate", "2026-01-01T00:00:01Z")], refs);
    expect(a.commandSaves).toBe(1);
    expect(a.commandsMatched).toBe(1);
  });

  test("does NOT credit when an earlier read/grep mentioned the command's term", () => {
    const a = attributeSession(
      [call("grep", "gate", "2026-01-01T00:00:00Z"), call("bash", "bun run gate", "2026-01-01T00:00:01Z")],
      refs,
    );
    expect(a.commandsMatched).toBe(1);
    expect(a.commandSaves).toBe(0);
  });

  test("counts each distinct remembered command once", () => {
    const a = attributeSession(
      [call("bash", "bun run gate", "2026-01-01T00:00:01Z"), call("bash", "bun run gate", "2026-01-01T00:00:02Z")],
      refs,
    );
    expect(a.commandSaves).toBe(1);
  });
});

describe("attributeSession — Tier B (file coverage) + new work", () => {
  const refs = { paths: ["src/gates.ts", "src/status.ts"], commands: [] };

  test("splits cited paths into re-read [measured] vs skipped [inferred]", () => {
    const a = attributeSession([call("read", "/abs/project/src/gates.ts", "2026-01-01T00:00:01Z")], refs);
    expect(a.pathsCited).toBe(2);
    expect(a.pathsReRead).toBe(1); // src/gates.ts was opened again
    expect(a.pathsSkipped).toBe(1); // src/status.ts was not
  });

  test("counts reads no memory covered as new work", () => {
    const a = attributeSession(
      [
        call("read", "src/gates.ts", "2026-01-01T00:00:01Z"),
        call("read", "src/brand-new.ts", "2026-01-01T00:00:02Z"),
      ],
      refs,
    );
    expect(a.readsTotal).toBe(2);
    expect(a.readsNotCovered).toBe(1);
  });
});

describe("attributeSession — empty inputs", () => {
  test("all zeros when nothing was injected or read", () => {
    const a = attributeSession([], { paths: [], commands: [] });
    expect(a).toEqual({
      commandSaves: 0,
      commandsMatched: 0,
      pathsCited: 0,
      pathsReRead: 0,
      pathsSkipped: 0,
      readsTotal: 0,
      readsNotCovered: 0,
    });
  });
});
