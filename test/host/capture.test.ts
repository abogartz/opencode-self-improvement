import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  configureAutoCapture,
  resetCaptureCooldowns,
} from "../../src/runtime/capture.ts";
import { resetCaptureCursors } from "../../src/capture/policy.ts";
import { guarded } from "../../src/core/hooks.ts";
import { session } from "../../src/core/state.ts";
import type {
  CaptureTranscript,
  MemoryCaptureHost,
} from "../../src/host/capture.ts";
import { createSessionContext } from "../../src/identity/session-context.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { isVisibleTo } from "../../src/store/model/visibility.ts";
import { readerFromSid } from "../../src/store/model/visibility.ts";
import { withTempStore } from "../harness.ts";

const store = withTempStore({ prefix: "osi-normalized-capture-" });
const FACT = "The nightly archive job keeps fourteen days of tarballs.";
const transcript: CaptureTranscript = [
  {
    role: "user",
    text: "We finished the archive change. Remember that the nightly archive job keeps fourteen days of tarballs. The batch importer respects the staging rate limit per key, which matters while wiring the importer tooling.",
  },
  {
    role: "assistant",
    text: "The archive policy has been verified and the importer will respect the staging limit.",
  },
];

function fixture({
  grounded = true,
  answer = Promise.resolve(
    JSON.stringify([
      { type: "context", scope: "batch", content: FACT, status: "settled" },
    ]),
  ),
} = {}) {
  resetCaptureCooldowns();
  resetCaptureCursors();
  const dir = join(store.root, "project");
  mkdirSync(dir);
  const identity = createSessionContext(
    {},
    { instanceDir: dir, liveRoot: dir },
  );
  const started = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const calls: Array<{ model: unknown; prompt: string }> = [];
  const host: MemoryCaptureHost = {
    subscribedEvents: ["turn-finished"],
    async *turnEndEvents() {
      try {
        await started.promise;
        yield { sessionID: "writer" };
      } finally {
        completed.resolve();
      }
    },
    async readTranscript(sid) {
      expect(sid).toBe("writer");
      return transcript;
    },
    async generateText(input) {
      calls.push(input);
      requested.resolve();
      return answer;
    },
    defaultModel: () => ({ providerID: "fixture", id: "capture" }),
  };
  session("writer").sawEngagement = grounded;
  const capture = configureAutoCapture(
    host,
    {},
    { instanceDir: dir, gateContext: identity.gateContext, guarded },
  );
  return { capture, calls, started, completed, requested, dir };
}

test("a normalized host captures through shared gates into the same project store", async () => {
  const f = fixture();
  try {
    f.started.resolve();
    await f.completed.promise;
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.model).toEqual({ providerID: "fixture", id: "capture" });
    expect(f.calls[0]!.prompt).toInclude(FACT.slice(4));
    const rows = await loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe(FACT);
    expect(rows[0]!.tags).toContain("auto-capture");
    const peer = createSessionContext(
      {},
      { instanceDir: f.dir, liveRoot: f.dir },
    );
    await peer.bindSessionIdentity("peer-harness-session");
    expect(isVisibleTo(rows[0]!, readerFromSid("peer-harness-session"))).toBe(
      true,
    );
    const otherDir = join(store.root, "other");
    mkdirSync(otherDir);
    const other = createSessionContext(
      {},
      { instanceDir: otherDir, liveRoot: otherDir },
    );
    await other.bindSessionIdentity("other-project");
    expect(isVisibleTo(rows[0]!, readerFromSid("other-project"))).toBe(false);
  } finally {
    await f.capture.cleanup?.();
  }
});

test("a normalized host cannot bypass behavior grounding", async () => {
  const f = fixture({ grounded: false });
  try {
    f.started.resolve();
    await f.completed.promise;
    expect(f.calls).toHaveLength(1);
    expect(await loadAll()).toEqual([]);
  } finally {
    await f.capture.cleanup?.();
  }
});

test("cleanup abandons an unanswered normalized generation and rejects later compaction", async () => {
  const answer = Promise.withResolvers<string>();
  const f = fixture({ answer: answer.promise });
  try {
    f.started.resolve();
    await f.requested.promise;
    const disposed = f.capture.cleanup?.();
    answer.resolve(
      JSON.stringify([
        { type: "context", scope: "batch", content: FACT, status: "settled" },
      ]),
    );
    await disposed;
    await f.completed.promise;
    f.capture.onCompactCapture?.("writer", transcript);
    expect(f.calls).toHaveLength(1);
    expect(await loadAll()).toEqual([]);
  } finally {
    answer.resolve("[]");
    await f.capture.cleanup?.();
  }
});
