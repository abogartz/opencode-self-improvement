import { describe, expect, test } from "bun:test";
import {
  captureSessionID,
  sessionDirectoryFromMessages,
  sessionDirectoryFromRow,
  sessionIdentityEvent,
  sessionUsageEvent,
  toolIdentity,
} from "../src/identity/host-events.ts";

describe("host compatibility adapters", () => {
  test("tool context uses id, with missing fields left to the caller's synchronous fallback", () => {
    expect(toolIdentity({ sessionID: "s", id: "call", callID: "other" }))
      .toEqual({ sessionID: "s", callID: "call" });
    expect(toolIdentity({ sessionID: "", id: 1 })).toEqual({ sessionID: undefined, callID: undefined });
    expect(toolIdentity({ sessionID: "s" })).toEqual({ sessionID: "s", callID: undefined });
    // The unresolved sentinel must not become the ambient session's identity.
    expect(toolIdentity({ sessionID: "?", id: "call" })).toEqual({ sessionID: "?", callID: "call" });
  });

  test.each(["session.created", "session.execution.started", "session.moved"])(
    "%s can identify a session without a directory (requiring the API backstop)",
    (type) => {
      expect(sessionIdentityEvent({ type, data: { sessionID: "s" } }))
        .toEqual({ sessionID: "s", directory: undefined });
    },
  );

  test.each([
    ["data location", { data: { sessionID: "s", location: { directory: "/repo" } } }],
    ["nested info", { data: { info: { sessionID: "s", location: { directory: "/repo" } } } }],
    ["properties info", { properties: { info: { sessionID: "s", directory: "/repo" } } }],
    ["root location", { data: { sessionID: "s" }, location: { directory: "/repo" } }],
    ["data identity with info location", { data: { sessionID: "s", info: { location: { directory: "/repo" } } } }],
    ["info identity with data location", { data: { info: { sessionID: "s" }, location: { directory: "/repo" } } }],
  ])("identity envelope: %s", (_name, envelope) => {
    expect(sessionIdentityEvent({ type: "session.created", ...envelope }))
      .toEqual({ sessionID: "s", directory: "/repo" });
  });

  test("identity precedence is data before properties, info before data, nested before root location", () => {
    expect(sessionIdentityEvent({
      type: "session.created",
      data: {
        sessionID: "data",
        info: { sessionID: "info", location: { directory: "/info" }, directory: "/flat" },
        location: { directory: "/data" },
      },
      properties: { sessionID: "properties" },
      location: { directory: "/root" },
    })).toEqual({ sessionID: "info", directory: "/info" });
    expect(sessionIdentityEvent({
      type: "session.created", data: { sessionID: "s", directory: "/flat" }, location: { directory: "/root" },
    })).toEqual({ sessionID: "s", directory: "/root" });
  });

  test("nullish fallback does not replace an invalid or empty primary identity", () => {
    expect(sessionIdentityEvent({
      type: "session.created", data: { sessionID: 123 }, properties: { sessionID: "other" },
    })).toBeUndefined();
    expect(sessionIdentityEvent({
      type: "session.created", data: { sessionID: "s", location: { directory: false }, directory: "/other" },
    })).toEqual({ sessionID: "s", directory: undefined });
    expect(sessionIdentityEvent({
      type: "session.created", data: { sessionID: "", location: { directory: "" } },
    })).toEqual({ sessionID: "", directory: "" });
    expect(sessionIdentityEvent({
      type: "session.created", data: null, properties: { sessionID: "s" },
    })).toEqual({ sessionID: "s", directory: undefined });
  });

  test("context lookup uses the first usable message directory", () => {
    expect(sessionDirectoryFromMessages([
      null,
      { location: { directory: "" }, info: { location: { directory: "/masked" } } },
      { info: { location: { directory: "/first" } } },
      { location: { directory: "/second" } },
    ])).toBe("/first");
    expect(sessionDirectoryFromMessages([{ location: { directory: "/direct" } }])).toBe("/direct");
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
    expect(sessionDirectoryFromRow({ data: {}, directory: "/outer" })).toBeUndefined();
    expect(sessionDirectoryFromRow({ location: { directory: "" }, directory: "/flat" })).toBeUndefined();
    expect(sessionDirectoryFromRow({ location: { directory: 123 }, directory: "/flat" })).toBeUndefined();
    expect(sessionDirectoryFromRow({ location: { directory: "/nested" }, directory: "/flat" })).toBe("/nested");
  });

  const info = { role: "assistant", sessionID: "s", tokens: { input: 10, cache: { read: 20, write: 30 } } };
  test.each([
    ["V2 usage", { type: "session.usage.updated", data: info }],
    ["legacy properties.info", { type: "message.updated", properties: { info } }],
    ["legacy info", { type: "message.updated", info }],
    ["legacy data.info", { type: "message.updated", data: { info } }],
  ])("usage envelope: %s", (_name, event) => {
    expect(sessionUsageEvent(event)).toEqual({ sessionID: "s", input: 10, read: 20, write: 30 });
  });

  test("legacy usage keeps envelope priority and ignores non-assistant messages", () => {
    const other = { ...info, sessionID: "other" };
    expect(sessionUsageEvent({ type: "message.updated", properties: { info }, info: other, data: { info: other } }))
      .toEqual({ sessionID: "s", input: 10, read: 20, write: 30 });
    expect(sessionUsageEvent({ type: "message.updated", info, data: { info: other } }))
      .toEqual({ sessionID: "s", input: 10, read: 20, write: 30 });
    expect(sessionUsageEvent({ type: "message.updated", properties: { info: { ...info, role: "user" } }, info }))
      .toBeUndefined();
    expect(sessionUsageEvent({ type: "message.updated", properties: { info: null }, info }))
      .toEqual({ sessionID: "s", input: 10, read: 20, write: 30 });
  });

  test("missing usage is distinct from measured zero; numeric coercion stays compatible", () => {
    expect(sessionUsageEvent({ type: "session.usage.updated", data: { sessionID: "s" } })).toBeUndefined();
    expect(sessionUsageEvent({ type: "session.usage.updated", data: { tokens: {} } })).toBeUndefined();
    expect(sessionUsageEvent({ type: "session.usage.updated", data: { sessionID: "s", tokens: {} } }))
      .toEqual({ sessionID: "s", input: 0, read: 0, write: 0 });
    expect(sessionUsageEvent({
      type: "session.usage.updated", data: { sessionID: "s", tokens: { input: "12", cache: { read: "bad", write: null } } },
    })).toEqual({ sessionID: "s", input: 12, read: 0, write: 0 });
  });

  test("capture session envelopes prefer data, then root, then properties", () => {
    expect(captureSessionID({ data: { sessionID: "data" }, sessionID: "root", properties: { sessionID: "props" } }))
      .toBe("data");
    expect(captureSessionID({ sessionID: "root", properties: { sessionID: "props" } })).toBe("root");
    expect(captureSessionID({ properties: { sessionID: "props" } })).toBe("props");
    expect(captureSessionID({ data: { sessionID: null }, sessionID: "root" })).toBe("root");
    expect(captureSessionID({ data: { sessionID: 123 }, sessionID: "root" })).toBeUndefined();
    expect(captureSessionID({ data: { sessionID: "" }, sessionID: "root" })).toBe("");
  });

  test.each([undefined, null, false, 1, "event", {}, []].map((raw) => ({ raw })))("missing/invalid payload: %j", ({ raw }) => {
    expect(toolIdentity(raw)).toEqual({ sessionID: undefined, callID: undefined });
    expect(sessionIdentityEvent(raw)).toBeUndefined();
    expect(sessionDirectoryFromMessages(raw)).toBeUndefined();
    expect(sessionDirectoryFromRow(raw)).toBeUndefined();
    expect(sessionUsageEvent(raw)).toBeUndefined();
    expect(captureSessionID(raw)).toBeUndefined();
  });

  test("unrelated event types do not bind identity or count usage", () => {
    const data = { ...info, location: { directory: "/repo" } };
    expect(sessionIdentityEvent({ type: "session.usage.updated", data })).toBeUndefined();
    expect(sessionUsageEvent({ type: "session.created", data })).toBeUndefined();
  });
});
