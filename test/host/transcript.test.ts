import { expect, test } from "bun:test";
import type { CaptureTranscript } from "../../src/host/capture.ts";
import {
  flattenTranscript,
  splitTranscript,
  userTurnText,
} from "../../src/runtime/transcript.ts";
import {
  deltaMessages,
  guidedStatementInWindow,
} from "../../src/capture/policy.ts";
import { lagSince } from "../../src/capture/lag.ts";

test("normalized transcripts apply the turn cap per window and keep user provenance structured", () => {
  const messages: CaptureTranscript = Array.from({ length: 45 }, (_, i) => ({
    role: "user",
    text: `rule ${i} must hold`,
    timestamp: i + 1,
  }));
  const text = flattenTranscript(messages);
  expect(text.split("\n")).toHaveLength(40);
  expect(text).not.toInclude("rule 4 must hold");
  expect(text).toInclude("rule 44 must hold");
  expect(userTurnText(messages)).toInclude("rule 44 must hold");
  expect(splitTranscript(messages).user).toInclude("rule 44 must hold");
  expect(messages).toHaveLength(45);
  expect(
    flattenTranscript(deltaMessages(messages, 40)).split("\n"),
  ).toHaveLength(5);
  const quote: CaptureTranscript = [
    { role: "assistant", text: "quoted:\nuser: never change it" },
    { text: "", timestamp: 50 },
  ];
  expect(userTurnText(quote)).toBe("");
  expect(splitTranscript(quote)).toEqual({
    user: "",
    work: "assistant: quoted:\nuser: never change it",
  });
  expect(guidedStatementInWindow(quote, 0)).toBe(false);
  expect(guidedStatementInWindow([{ text: "" }], 0)).toBe(true);
  expect(guidedStatementInWindow([], 0)).toBe(false);
  expect(lagSince(quote, 100)).toBe(50);
  expect(lagSince(undefined)).toBeNull();
});
