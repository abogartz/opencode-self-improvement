import { describe, expect, test } from "bun:test";
import {
  captureSessionID,
  foldUsage,
  forgetUsage,
  sessionDirectoryFromMessages,
  sessionDirectoryFromRow,
  sessionIdentityEvent,
  sessionUsageEvent,
  toolIdentity,
} from "../src/identity/host-events.ts";

describe("host compatibility adapters", () => {
  test("tool context uses id, with missing fields left to the caller's synchronous fallback", () => {
    expect(
      toolIdentity({ sessionID: "s", id: "call", callID: "other" }),
    ).toEqual({ sessionID: "s", callID: "call" });
    expect(toolIdentity({ sessionID: "", id: 1 })).toEqual({
      sessionID: undefined,
      callID: undefined,
    });
    expect(toolIdentity({ sessionID: "s" })).toEqual({
      sessionID: "s",
      callID: undefined,
    });
    // The unresolved sentinel must not become the ambient session's identity.
    expect(toolIdentity({ sessionID: "?", id: "call" })).toEqual({
      sessionID: "?",
      callID: "call",
    });
  });

  test.each(["session.created", "session.execution.started", "session.moved"])(
    "%s can identify a session without a directory (requiring the API backstop)",
    (type) => {
      expect(sessionIdentityEvent({ type, data: { sessionID: "s" } })).toEqual({
        sessionID: "s",
        directory: undefined,
      });
    },
  );

  test.each([
    [
      "data location",
      { data: { sessionID: "s", location: { directory: "/repo" } } },
    ],
    [
      "nested info",
      { data: { info: { sessionID: "s", location: { directory: "/repo" } } } },
    ],
    [
      "properties info",
      { properties: { info: { sessionID: "s", directory: "/repo" } } },
    ],
    [
      "root location",
      { data: { sessionID: "s" }, location: { directory: "/repo" } },
    ],
    [
      "data identity with info location",
      { data: { sessionID: "s", info: { location: { directory: "/repo" } } } },
    ],
    [
      "info identity with data location",
      { data: { info: { sessionID: "s" }, location: { directory: "/repo" } } },
    ],
  ])("identity envelope: %s", (_name, envelope) => {
    expect(
      sessionIdentityEvent({ type: "session.created", ...envelope }),
    ).toEqual({ sessionID: "s", directory: "/repo" });
  });

  test("identity precedence is data before properties, info before data, nested before root location", () => {
    expect(
      sessionIdentityEvent({
        type: "session.created",
        data: {
          sessionID: "data",
          info: {
            sessionID: "info",
            location: { directory: "/info" },
            directory: "/flat",
          },
          location: { directory: "/data" },
        },
        properties: { sessionID: "properties" },
        location: { directory: "/root" },
      }),
    ).toEqual({ sessionID: "info", directory: "/info" });
    expect(
      sessionIdentityEvent({
        type: "session.created",
        data: { sessionID: "s", directory: "/flat" },
        location: { directory: "/root" },
      }),
    ).toEqual({ sessionID: "s", directory: "/root" });
  });

  test("nullish fallback does not replace an invalid or empty primary identity", () => {
    expect(
      sessionIdentityEvent({
        type: "session.created",
        data: { sessionID: 123 },
        properties: { sessionID: "other" },
      }),
    ).toBeUndefined();
    expect(
      sessionIdentityEvent({
        type: "session.created",
        data: {
          sessionID: "s",
          location: { directory: false },
          directory: "/other",
        },
      }),
    ).toEqual({ sessionID: "s", directory: undefined });
    expect(
      sessionIdentityEvent({
        type: "session.created",
        data: { sessionID: "", location: { directory: "" } },
      }),
    ).toEqual({ sessionID: "", directory: "" });
    expect(
      sessionIdentityEvent({
        type: "session.created",
        data: null,
        properties: { sessionID: "s" },
      }),
    ).toEqual({ sessionID: "s", directory: undefined });
  });

  test("context lookup uses the first usable message directory", () => {
    expect(
      sessionDirectoryFromMessages([
        null,
        {
          location: { directory: "" },
          info: { location: { directory: "/masked" } },
        },
        { info: { location: { directory: "/first" } } },
        { location: { directory: "/second" } },
      ]),
    ).toBe("/first");
    expect(
      sessionDirectoryFromMessages([{ location: { directory: "/direct" } }]),
    ).toBe("/direct");
  });

  test.each([
    { location: { directory: "/repo" } },
    { directory: "/repo" },
    { data: { location: { directory: "/repo" } } },
    { data: { directory: "/repo" } },
    { data: null, directory: "/repo" },
  ])("session.get accepts direct and wrapped rows: %j", (row) => {
    expect(sessionDirectoryFromRow(row)).toBe("/repo");
  });

  test("session row precedence does not bind to a fallback after an empty/invalid primary", () => {
    expect(
      sessionDirectoryFromRow({ data: {}, directory: "/outer" }),
    ).toBeUndefined();
    expect(
      sessionDirectoryFromRow({
        location: { directory: "" },
        directory: "/flat",
      }),
    ).toBeUndefined();
    expect(
      sessionDirectoryFromRow({
        location: { directory: 123 },
        directory: "/flat",
      }),
    ).toBeUndefined();
    expect(
      sessionDirectoryFromRow({
        location: { directory: "/nested" },
        directory: "/flat",
      }),
    ).toBe("/nested");
  });

  const info = {
    role: "assistant",
    sessionID: "s",
    tokens: {
      input: 10,
      output: 40,
      reasoning: 50,
      cache: { read: 20, write: 30 },
    },
  };
  test.each([
    ["V2 usage", { type: "session.usage.updated", data: info }],
    [
      "legacy properties.info",
      { type: "message.updated", properties: { info } },
    ],
    ["legacy info", { type: "message.updated", info }],
    ["legacy data.info", { type: "message.updated", data: { info } }],
  ])("usage envelope: %s", (_name, event) => {
    expect(sessionUsageEvent(event)).toMatchObject({
      sessionID: "s",
      input: 10,
      read: 20,
      write: 30,
      output: 40,
      reasoning: 50,
    });
  });

  test("#394 review: the two sources are told apart — cumulative replaces, message receipts sum", () => {
    // The finding: with message-1 usage 50 answer + 20 reasoning and
    // message-2 usage 60 + 30, the old overwrite rendered 90 "session-wide"
    // although the session produced 160.
    const msg = (id: string, output: number, reasoning: number) =>
      sessionUsageEvent({
        type: "message.updated",
        properties: {
          info: {
            id,
            role: "assistant",
            sessionID: "s",
            tokens: {
              input: 1,
              output,
              reasoning,
              cache: { read: 0, write: 0 },
            },
          },
        },
      })!;
    // Streaming: repeated updates for the SAME message overwrite each other.
    foldUsage(msg("m1", 40, 15), "2026-11-11T00:00:00.000Z");
    const afterM1 = foldUsage(msg("m1", 50, 20), "2026-11-11T00:00:01.000Z");
    expect(afterM1.output).toBe(50);
    expect(afterM1.reasoning).toBe(20);
    // A second message ADDS: 50+20 and 60+30 = 160, not 90.
    const both = foldUsage(msg("m2", 60, 30), "2026-11-11T00:00:02.000Z");
    expect((both.output ?? 0) + (both.reasoning ?? 0)).toBe(160);
    // A cumulative source replaces the total outright.
    const cum = foldUsage(
      sessionUsageEvent({
        type: "session.usage.updated",
        data: {
          sessionID: "s",
          tokens: { input: 7, output: 8, reasoning: 9, cache: {} },
        },
      })!,
      "2026-11-11T00:00:03.000Z",
    );
    expect(cum.output).toBe(8);
    expect(cum.reasoning).toBe(9);
    // Eviction clears the per-message ledger: after forgetUsage the next
    // message receipt stands alone, not added to ghosts of the old session.
    forgetUsage("s");
    const fresh = foldUsage(msg("m3", 5, 5), "2026-11-11T00:00:04.000Z");
    expect((fresh.output ?? 0) + (fresh.reasoning ?? 0)).toBe(10);
  });

  test("#387: completion tokens are read, and an older host yields 0 rather than undefined", () => {
    expect(
      sessionUsageEvent({ type: "session.usage.updated", data: info }),
    ).toMatchObject({
      output: 40,
      reasoning: 50,
    });
    // A host that reports no completion tokens must not produce a surface that
    // claims the session generated nothing: 0 here, and the status renderer
    // gates its generation line on a nonzero instead of printing it.
    const thin = {
      role: "assistant",
      sessionID: "s",
      tokens: { input: 10, cache: { read: 20, write: 30 } },
    };
    expect(
      sessionUsageEvent({ type: "session.usage.updated", data: thin }),
    ).toEqual({
      sessionID: "s",
      cumulative: true,
      input: 10,
      read: 20,
      write: 30,
      output: 0,
      reasoning: 0,
    });
    // Reasoning is where a local seat's cost actually goes (measured: 94% of a
    // capture call's completion tokens), so it must not be folded into output.
    const split = {
      role: "assistant",
      sessionID: "s",
      tokens: {
        input: 1,
        output: 7,
        reasoning: 2277,
        cache: { read: 0, write: 0 },
      },
    };
    const got = sessionUsageEvent({
      type: "session.usage.updated",
      data: split,
    });
    expect(got?.output).toBe(7);
    expect(got?.reasoning).toBe(2277);
  });

  test("legacy usage keeps envelope priority and ignores non-assistant messages", () => {
    const other = { ...info, sessionID: "other" };
    expect(
      sessionUsageEvent({
        type: "message.updated",
        properties: { info },
        info: other,
        data: { info: other },
      }),
    ).toEqual({
      sessionID: "s",
      input: 10,
      read: 20,
      write: 30,
      output: 40,
      reasoning: 50,
    });
    expect(
      sessionUsageEvent({
        type: "message.updated",
        info,
        data: { info: other },
      }),
    ).toEqual({
      sessionID: "s",
      input: 10,
      read: 20,
      write: 30,
      output: 40,
      reasoning: 50,
    });
    expect(
      sessionUsageEvent({
        type: "message.updated",
        properties: { info: { ...info, role: "user" } },
        info,
      }),
    ).toBeUndefined();
    expect(
      sessionUsageEvent({
        type: "message.updated",
        properties: { info: null },
        info,
      }),
    ).toEqual({
      sessionID: "s",
      input: 10,
      read: 20,
      write: 30,
      output: 40,
      reasoning: 50,
    });
  });

  test("missing usage is distinct from measured zero; numeric coercion stays compatible", () => {
    expect(
      sessionUsageEvent({
        type: "session.usage.updated",
        data: { sessionID: "s" },
      }),
    ).toBeUndefined();
    expect(
      sessionUsageEvent({
        type: "session.usage.updated",
        data: { tokens: {} },
      }),
    ).toBeUndefined();
    expect(
      sessionUsageEvent({
        type: "session.usage.updated",
        data: { sessionID: "s", tokens: {} },
      }),
    ).toEqual({
      sessionID: "s",
      cumulative: true,
      input: 0,
      read: 0,
      write: 0,
      output: 0,
      reasoning: 0,
    });
    expect(
      sessionUsageEvent({
        type: "session.usage.updated",
        data: {
          sessionID: "s",
          tokens: {
            input: "12",
            output: "9",
            reasoning: "1.5e3",
            cache: { read: "bad", write: null },
          },
        },
      }),
    ).toEqual({
      sessionID: "s",
      cumulative: true,
      input: 12,
      read: 0,
      write: 0,
      output: 9,
      reasoning: 1500,
    });
  });

  test("capture session envelopes prefer data, then root, then properties", () => {
    expect(
      captureSessionID({
        data: { sessionID: "data" },
        sessionID: "root",
        properties: { sessionID: "props" },
      }),
    ).toBe("data");
    expect(
      captureSessionID({
        sessionID: "root",
        properties: { sessionID: "props" },
      }),
    ).toBe("root");
    expect(captureSessionID({ properties: { sessionID: "props" } })).toBe(
      "props",
    );
    expect(
      captureSessionID({ data: { sessionID: null }, sessionID: "root" }),
    ).toBe("root");
    expect(
      captureSessionID({ data: { sessionID: 123 }, sessionID: "root" }),
    ).toBeUndefined();
    expect(
      captureSessionID({ data: { sessionID: "" }, sessionID: "root" }),
    ).toBe("");
  });

  test.each(
    [undefined, null, false, 1, "event", {}, []].map((raw) => ({ raw })),
  )("missing/invalid payload: %j", ({ raw }) => {
    expect(toolIdentity(raw)).toEqual({
      sessionID: undefined,
      callID: undefined,
    });
    expect(sessionIdentityEvent(raw)).toBeUndefined();
    expect(sessionDirectoryFromMessages(raw)).toBeUndefined();
    expect(sessionDirectoryFromRow(raw)).toBeUndefined();
    expect(sessionUsageEvent(raw)).toBeUndefined();
    expect(captureSessionID(raw)).toBeUndefined();
  });

  test("unrelated event types do not bind identity or count usage", () => {
    const data = { ...info, location: { directory: "/repo" } };
    expect(
      sessionIdentityEvent({ type: "session.usage.updated", data }),
    ).toBeUndefined();
    expect(
      sessionUsageEvent({ type: "session.created", data }),
    ).toBeUndefined();
  });
});
