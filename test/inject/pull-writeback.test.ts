// Where the pull writes. The host hands back different result shapes across
// versions, and only ONE of the fields it exposes actually reaches the model —
// measured in e2e/pull-delivery.test.ts, pinned mechanically here.
import { describe, expect, test } from "bun:test";
import { writePullIntoResult } from "../../src/inject/host-delivery.ts";

const BLOCK = "\n## Related durable memory — remembered facts\n- row";

describe("writePullIntoResult", () => {
  test("Scenario: v2.3.0 parts array — appends to the text part the host forwards", () => {
    const result = {
      output: { type: "file", uri: "file:///x", content: "RAW FILE" },
      content: [{ type: "text", text: "OUT" }],
      metadata: { truncated: false },
    };
    expect(writePullIntoResult(result, "OUT", "OUT" + BLOCK)).toBe(true);
    expect((result.content[0] as any).text).toBe("OUT" + BLOCK);
    // The file attachment is the host's own payload and never reaches the
    // model as text: mutating it was the original silent failure.
    expect((result.output as any).content).toBe("RAW FILE");
  });

  test("Scenario: older host — a plain string content is replaced wholesale", () => {
    const result: any = { content: "OUT" };
    expect(writePullIntoResult(result, "OUT", "OUT" + BLOCK)).toBe(true);
    expect(result.content).toBe("OUT" + BLOCK);
  });

  test("Scenario: several parts — the pull lands after the last text part", () => {
    const result: any = {
      content: [
        { type: "text", text: "FIRST" },
        { type: "image", url: "x" },
        { type: "text", text: "LAST" },
      ],
    };
    expect(
      writePullIntoResult(result, "FIRST\nLAST", "FIRST\nLAST" + BLOCK),
    ).toBe(true);
    expect(result.content[2].text).toBe("LAST" + BLOCK);
    expect(result.content[0].text).toBe("FIRST");
  });

  test("Scenario: no text part at all — a new one is added rather than dropped", () => {
    const result: any = { content: [{ type: "image", url: "x" }] };
    expect(writePullIntoResult(result, "", BLOCK)).toBe(true);
    expect(result.content.length).toBe(2);
    expect(result.content[1]).toEqual({ type: "text", text: BLOCK });
  });

  test("Scenario: another hook rewrote the text — refuse rather than clobber", () => {
    const result: any = { content: [{ type: "text", text: "OUT" }] };
    // `after` shares no prefix with `before`, so the append cannot be isolated.
    // Writing anyway would either drop the host's text or duplicate it.
    expect(writePullIntoResult(result, "OUT", "REWRITTEN" + BLOCK)).toBe(false);
    expect(result.content[0].text).toBe("OUT");
  });

  test("Scenario: nothing appended, nothing written", () => {
    const result: any = { content: [{ type: "text", text: "OUT" }] };
    expect(writePullIntoResult(result, "OUT", "OUT")).toBe(false);
    expect(result.content[0].text).toBe("OUT");
  });

  test("Scenario: a result with nowhere to write reports failure, not delivery", () => {
    expect(writePullIntoResult(null, "OUT", "OUT" + BLOCK)).toBe(false);
    expect(writePullIntoResult("a string", "OUT", "OUT" + BLOCK)).toBe(false);
    expect(writePullIntoResult({ output: "OUT" }, "OUT", "OUT" + BLOCK)).toBe(
      false,
    );
    expect(writePullIntoResult({ content: 7 }, "OUT", "OUT" + BLOCK)).toBe(
      false,
    );
  });
});
