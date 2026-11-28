import { observedToolResults } from "../../src/adapters/opencode/delivery.ts";
// A pull is credited when the request carries it, not when it is placed.
// The receipt book is pure state, so its contract is pinned here without a
// host: which rows a request's tool-result proves, and what is reported
// instead when it proves less.
import { describe, expect, test } from "bun:test";
import { formatMemory } from "../../src/inject/format.ts";
import { PULL_HEADER } from "../../src/inject/pull.ts";
import {
  createPullReceipts as createReceiptBook,
  HELD_PULL_TTL_MS,
  type HeldPull,
} from "../../src/inject/pull-receipts.ts";
import type { Memory } from "../../src/store/model/memory.ts";

const T0 = Date.parse("2026-11-21T10:00:00.000Z");

const row = (n: number): Memory => ({
  ts: `2026-11-21T09:00:0${n}.000Z`,
  type: "learning",
  scope: "fixture",
  content: `ERR_MODULE_NOT_FOUND row-${n} needs a clean checkout`,
  file: "2026-11-21.logfmt",
  index: n,
});
const A = row(1);
const B = row(2);

function placed(rows: Memory[], over: Partial<HeldPull> = {}): HeldPull {
  return {
    sid: "ses-a",
    callID: "call-1",
    header: PULL_HEADER,
    evidence: { sid: "ses-a", call: "call-1", scope: null },
    tool: "read",
    rows,
    lines: rows.map(formatMemory),
    query: "ERR_MODULE_NOT_FOUND",
    at: T0,
    turn: 1,
    turnKey: "k1",
    ...over,
  };
}

// The text a tool-result carries when the whole pull block survived.
const delivered = (rows: Memory[], prefix = "file body") =>
  [prefix, PULL_HEADER, ...rows.map(formatMemory)].join("\n");

// One request, shaped like the vendored host schema: a tool message whose
// tool-result part names the call and carries the text the provider reads.
function request(
  callID: string,
  text: string,
  shape: "content" | "text" | "error" | "json" = "content",
) {
  const result =
    shape === "content"
      ? { type: "content", value: [{ type: "text", text }] }
      : shape === "json"
        ? { type: "json", value: { text } }
        : { type: shape, value: text };
  return [
    { role: "user", content: [{ type: "text", text: "inspect notes" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", id: callID, name: "read", input: {} }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", id: callID, name: "read", result }],
    },
  ];
}

const ids = (rows: Memory[]) => rows.map((m) => m.ts);

describe("Feature: credit what the request carries", () => {
  test("Scenario: the whole block survived — every placed row is credited, in placed order", () => {
    const book = createPullReceipts();
    book.hold(placed([A, B]));
    const { credits, losses } = book.settle(
      "ses-a",
      request("call-1", delivered([A, B])),
      T0 + 1,
    );
    expect(credits).toHaveLength(1);
    expect(ids(credits[0].rows)).toEqual([A.ts, B.ts]);
    // The credit carries the placement's own query, time and turn.
    expect(credits[0].held).toMatchObject({
      query: "ERR_MODULE_NOT_FOUND",
      at: T0,
      turn: 1,
      turnKey: "k1",
    });
    expect(losses).toEqual([]);
    expect(book.size()).toBe(0);
  });

  test("Scenario: a later limiter cut the block — nothing is credited and the loss is counted", () => {
    const book = createPullReceipts();
    book.hold(placed([A]));
    // The original output is long enough that 200 characters end inside it.
    const full = delivered(
      [A],
      `ERR_MODULE_NOT_FOUND\n${"padding ".repeat(40)}`,
    );
    expect(full.slice(0, 200)).not.toContain(PULL_HEADER);
    const { credits, losses } = book.settle(
      "ses-a",
      request("call-1", full.slice(0, 200)),
      T0 + 1,
    );
    expect(credits).toEqual([]);
    expect(losses).toEqual([]);
    const expired = book.settle("ses-a", [], T0 + HELD_PULL_TTL_MS + 1);
    expect(expired.losses.map(({ rows, reason }) => [rows, reason])).toEqual([
      [1, "expired"],
    ]);
    expect(book.settle("ses-a", [], T0 + HELD_PULL_TTL_MS + 2).losses).toEqual(
      [],
    );
  });

  test("an earlier pull with identical rows cannot confirm a new placement", () => {
    const book = createPullReceipts();
    book.hold(placed([A], { header: PULL_HEADER + " [fresh]" }));
    const { credits, losses } = book.settle(
      "ses-a",
      request("call-1", delivered([A])),
      T0 + 1,
    );
    expect(credits).toHaveLength(0);
    expect(losses).toEqual([]);
    expect(
      book.settle("ses-a", request("call-1", delivered([A])), T0 + 2).losses,
    ).toHaveLength(0);
    const fresh = delivered([A]).replace(PULL_HEADER, PULL_HEADER + " [fresh]");
    const later = book.settle("ses-a", request("call-1", fresh), T0 + 3);
    expect(later.credits[0]?.rows).toEqual([A]);
    expect(later.losses).toEqual([]);
    expect(book.size()).toBe(0);
  });

  test("a quoted header cannot displace an exact header in either result order", () => {
    const entry = placed([A], { header: PULL_HEADER + " [fresh]" });
    const exact = request(
      entry.callID,
      [entry.header, formatMemory(A)].join("\r\n"),
    );
    const quoted = request(entry.callID, "quoted " + entry.header);
    for (const messages of [exact.concat(quoted), quoted.concat(exact)]) {
      const book = createPullReceipts();
      book.hold(entry);
      const { credits, losses } = book.settle(entry.sid, messages, T0 + 1);
      expect(credits.map((c) => c.rows)).toEqual([[A]]);
      expect(losses).toEqual([]);
    }
  });

  test("duplicate results credit each row proved by any copy in either order", () => {
    const full = request("call-1", delivered([A, B]));
    const clipped = request("call-1", delivered([B]));
    for (const messages of [full.concat(clipped), clipped.concat(full)]) {
      const book = createPullReceipts();
      book.hold(placed([A, B]));
      const { credits, losses } = book.settle("ses-a", messages, T0 + 1);
      expect(credits.map((c) => c.rows)).toEqual([[A, B]]);
      expect(losses).toEqual([]);
    }
    const book = createPullReceipts();
    book.hold(placed([A, { ...A, ts: B.ts }]));
    const single = request("call-1", delivered([A]));
    const result = book.settle("ses-a", single.concat(single), T0 + 1);
    expect(result.credits).toEqual([]);
    expect(result.losses.map((l) => l.rows)).toEqual([2]);
  });

  test("one result with repeated clipped blocks cannot combine ambiguous copies", () => {
    const twin = { ...A, ts: B.ts };
    const clipped = delivered([A]);
    const complete = delivered([A, twin]);
    for (const [text, expected] of [
      [clipped + "\r\n" + clipped, []],
      [clipped + "\n" + complete, [A, twin]],
      [complete + "\n" + clipped, [A, twin]],
    ] as const) {
      const book = createPullReceipts();
      book.hold(placed([A, twin]));
      const result = book.settle("ses-a", request("call-1", text), T0 + 1);
      expect(result.credits.flatMap((c) => c.rows)).toEqual([...expected]);
      expect(result.losses.map((l) => l.rows)).toEqual(
        expected.length ? [] : [2],
      );
    }
  });

  test("a different tool with a reused call ID cannot settle the placement", () => {
    const book = createPullReceipts();
    book.hold(placed([A], { tool: "grep" }));
    expect(
      book.settle("ses-a", request("call-1", delivered([A])), T0 + 1),
    ).toEqual({ credits: [], losses: [] });
    expect(book.size()).toBe(1);
  });

  test("Scenario: the last row was cut mid-line — only the whole lines count", () => {
    const book = createPullReceipts();
    book.hold(placed([A, B]));
    const { credits, losses } = book.settle(
      "ses-a",
      request("call-1", delivered([A, B]).slice(0, -8)),
      T0 + 1,
    );
    expect(ids(credits[0].rows)).toEqual([A.ts]);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ rows: 1, reason: "trimmed" });
  });

  test("Scenario: a footer appended after the block — the rows are still whole lines", () => {
    const book = createPullReceipts();
    book.hold(placed([A]));
    const { credits, losses } = book.settle(
      "ses-a",
      request("call-1", `${delivered([A])}\n-- footer --`),
      T0 + 1,
    );
    expect(ids(credits[0].rows)).toEqual([A.ts]);
    expect(losses).toEqual([]);
  });

  test("a footer echo cannot prove a second indistinguishable row", () => {
    const twin = { ...A, ts: B.ts };
    const book = createPullReceipts();
    book.hold(placed([A, twin]));
    const text = `${delivered([A])}\n-- footer --\n${formatMemory(A)}`;
    const { credits, losses } = book.settle(
      "ses-a",
      request("call-1", text),
      T0 + 1,
    );
    expect(credits).toEqual([]);
    expect(losses.map(({ rows, reason }) => [rows, reason])).toEqual([
      [2, "trimmed"],
    ]);
  });

  test("Scenario: the row's text appears in the file but the block is gone — no credit", () => {
    const book = createPullReceipts();
    book.hold(placed([A]));
    // A file that already quotes the rendered line (an old transcript) proves
    // nothing about the block this call placed.
    const text = `${formatMemory(A)}\nmore file body`;
    const { credits, losses } = book.settle(
      "ses-a",
      request("call-1", text),
      T0 + 1,
    );
    expect(credits).toEqual([]);
    expect(losses).toEqual([]);
    expect(book.size()).toBe(1);
  });

  test("Scenario: two rows render the same line and one copy survives — neither ID is credited", () => {
    const book = createPullReceipts();
    // Same rendered line, different row IDs.
    const twin: Memory = { ...A, ts: "2026-11-21T09:00:09.000Z" };
    expect(formatMemory(twin)).toBe(formatMemory(A));
    book.hold(placed([A, twin, B]));
    const cut = [
      "file body",
      PULL_HEADER,
      formatMemory(A),
      formatMemory(B),
    ].join("\n");
    const { credits, losses } = book.settle(
      "ses-a",
      request("call-1", cut),
      T0 + 1,
    );
    expect(ids(credits[0].rows)).toEqual([B.ts]);
    expect(losses[0]).toMatchObject({ rows: 2, reason: "trimmed" });

    // Both copies survived: both IDs are attributable.
    book.hold(placed([A, twin], { callID: "call-2" }));
    expect(
      ids(
        book.settle("ses-a", request("call-2", delivered([A, twin])), T0 + 2)
          .credits[0].rows,
      ),
    ).toEqual([A.ts, twin.ts]);
  });

  test.each(["content", "text", "error"] as const)(
    "Scenario: the host's %s result shape is read",
    (shape) => {
      const book = createPullReceipts();
      book.hold(placed([A]));
      const { credits } = book.settle(
        "ses-a",
        request("call-1", delivered([A]), shape),
        T0 + 1,
      );
      expect(ids(credits[0].rows)).toEqual([A.ts]);
    },
  );

  test("Scenario: a JSON result without the placement header remains pending", () => {
    const book = createPullReceipts();
    book.hold(placed([A]));
    const { credits, losses } = book.settle(
      "ses-a",
      request("call-1", delivered([A]), "json"),
      T0 + 1,
    );
    expect(credits).toEqual([]);
    expect(losses).toEqual([]);
    expect(book.size()).toBe(1);
  });
});

describe("Feature: one placement, one settlement", () => {
  test("Scenario: a later request re-sends the same tool-result — it is not credited twice", () => {
    const book = createPullReceipts();
    book.hold(placed([A]));
    const messages = request("call-1", delivered([A]));
    expect(book.settle("ses-a", messages, T0 + 1).credits).toHaveLength(1);
    expect(book.settle("ses-a", messages, T0 + 2)).toEqual({
      credits: [],
      losses: [],
    });
  });

  test("Scenario: a request that does not carry the call yet leaves it held", () => {
    const book = createPullReceipts();
    book.hold(placed([A]));
    expect(book.settle("ses-a", request("other", "x"), T0 + 1)).toEqual({
      credits: [],
      losses: [],
    });
    expect(book.size()).toBe(1);
    expect(
      book.settle("ses-a", request("call-1", delivered([A])), T0 + 2).credits,
    ).toHaveLength(1);
  });

  test("Scenario: another session's request cannot settle this session's call", () => {
    const book = createPullReceipts();
    book.hold(placed([A]));
    const messages = request("call-1", delivered([A]));
    expect(book.settle("ses-b", messages, T0 + 1).credits).toEqual([]);
    expect(book.settle(undefined, messages, T0 + 1).credits).toEqual([]);
    expect(book.size()).toBe(1);
    expect(book.settle("ses-a", messages, T0 + 2).credits).toHaveLength(1);
  });

  test("Scenario: the same call ID in two sessions is two placements", () => {
    const book = createPullReceipts();
    book.hold(placed([A]));
    book.hold(placed([B], { sid: "ses-b" }));
    expect(book.size()).toBe(2);
    const b = book.settle("ses-b", request("call-1", delivered([B])), T0 + 1);
    expect(ids(b.credits[0].rows)).toEqual([B.ts]);
    expect(book.size()).toBe(1);
  });

  test("Scenario: a repeated call ID replaces the earlier placement", () => {
    const book = createPullReceipts();
    book.hold(placed([A]));
    const replaced = book.hold(placed([B]));
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({
      reason: "replaced",
      rows: 1,
      held: { rows: [A] },
    });
    expect(book.size()).toBe(1);
    const { credits } = book.settle(
      "ses-a",
      request("call-1", delivered([B])),
      T0 + 1,
    );
    expect(ids(credits[0].rows)).toEqual([B.ts]);
  });

  test("Scenario: two receipt books never see each other's placements", () => {
    const one = createPullReceipts();
    const two = createPullReceipts();
    one.hold(placed([A]));
    two.hold(placed([B]));
    const messages = request("call-1", delivered([A]));
    expect(ids(one.settle("ses-a", messages, T0 + 1).credits[0].rows)).toEqual([
      A.ts,
    ]);
    // Book two's placement had B; the request carried only A.
    expect(two.settle("ses-a", messages, T0 + 1).losses[0]).toMatchObject({
      rows: 1,
      reason: "trimmed",
    });
  });
});

describe("Feature: retention is bounded and stale placements are never credited", () => {
  test("Scenario: a placement past the TTL is reported expired even if a request now carries it", () => {
    const book = createPullReceipts();
    book.hold(placed([A]));
    book.hold(placed([B], { sid: "ses-b", at: T0 + HELD_PULL_TTL_MS }));
    const { credits, losses } = book.settle(
      "ses-a",
      request("call-1", delivered([A])),
      T0 + HELD_PULL_TTL_MS + 1,
    );
    expect(credits).toEqual([]);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ rows: 1, reason: "expired" });
    expect(losses[0].held.sid).toBe("ses-a");
    // The younger placement in another session is untouched.
    expect(book.size()).toBe(1);
  });

  test("Scenario: the cap evicts the oldest placement and says so", () => {
    const book = createPullReceipts({ max: 2 });
    expect(book.hold(placed([A], { callID: "c1" }))).toEqual([]);
    expect(book.hold(placed([A, B], { callID: "c2" }))).toEqual([]);
    const lost = book.hold(placed([B], { callID: "c3" }));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ rows: 1, reason: "evicted" });
    expect(lost[0].held.callID).toBe("c1");
    expect(book.size()).toBe(2);
    // The evicted call can no longer be credited.
    expect(
      book.settle("ses-a", request("c1", delivered([A])), T0 + 1).credits,
    ).toEqual([]);
  });
});

function createPullReceipts(options?: Parameters<typeof createReceiptBook>[0]) {
  const book = createReceiptBook(options);
  return {
    ...book,
    settle(sid: string | undefined, messages: unknown, now?: number) {
      return book.settle(sid, observedToolResults(messages), now);
    },
  };
}
