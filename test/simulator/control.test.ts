import { expect, test } from "bun:test";
import { ControlledCall, Trace, checkpoint } from "./control.ts";

test("scripted calls can complete out of order without sharing inputs or responses", async () => {
  const trace = new Trace();
  const calls = new ControlledCall<{ text: string }, string>(
    trace,
    "h",
    "model",
    () => "default",
  );
  const first = calls.pause("first");
  const second = calls.pause("second");
  const input = { text: "original" };
  const a = calls.call(input);
  input.text = "mutated";
  const b = calls.call({ text: "other" });
  expect(await first.entered).toEqual({ text: "original" });
  expect(await second.entered).toEqual({ text: "other" });
  second.resolve("B");
  expect(await b).toBe("B");
  first.resolve("A");
  expect(await a).toBe("A");
  expect(
    trace.entries
      .filter((e) => e.event === "model.returned")
      .map((e) => e.detail),
  ).toEqual(["B", "A"]);
  expect(await calls.call({ text: "fallback" })).toBe("default");
});

test("trace snapshots retain event identity while replacing delivery callbacks", () => {
  const trace = new Trace();
  const event = { sessionID: "a", appendSystem() {} };
  trace.add("h", "context", event);
  event.sessionID = "b";
  expect(trace.entries[0]?.detail).toEqual({
    sessionID: "a",
    appendSystem: "[callback]",
  });
});

test("a missing checkpoint fails by name and closing cancels an unreached plan", async () => {
  await expect(
    checkpoint("never arrived", new Promise(() => {}), 1),
  ).rejects.toThrow("Checkpoint timed out: never arrived");
  const calls = new ControlledCall<void, void>(
    new Trace(),
    "h",
    "registration",
    () => {},
  );
  const held = calls.pause("not reached");
  calls.close();
  await expect(held.entered).rejects.toThrow("Scenario closed");
  await expect(calls.call()).rejects.toThrow("closed");
});
