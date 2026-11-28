import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { registerHooks, type RideAt } from "../../src/runtime/events.ts";
import type { LifecycleHandlers } from "../../src/host/lifecycle.ts";
import { guarded } from "../../src/core/hooks.ts";
import { createSessionContext } from "../../src/identity/session-context.ts";
import { createInjectionEpochs } from "../../src/inject/epochs.ts";
import { PULL_SHIPPED } from "../../src/inject/pull.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import type { Memory } from "../../src/store/model/memory.ts";
import type { HitSource } from "../../src/telemetry/ledger.ts";
import { withTempStore } from "../harness.ts";

const store = withTempStore({ prefix: "osi-normalized-lifecycle-" });
const FACT = "ERR_MODULE_NOT_FOUND vite.config.ts requires a clean checkout.";

async function setup() {
  const dir = join(store.root, "project");
  mkdirSync(dir);
  const identity = createSessionContext(
    { fromSession: async () => dir },
    { instanceDir: dir, liveRoot: dir },
  );
  const hits: Array<{
    source: HitSource;
    sid: string;
    rows: Memory[];
    at?: RideAt;
  }> = [];
  const noteHits = async (
    source: HitSource,
    sid: string,
    rows: Memory[],
    _query: string,
    at?: RideAt,
  ) => {
    hits.push({ source, sid, rows, at });
  };
  const measuredTurns = new Map();
  const sessions = createInjectionEpochs({
    budget: 1200,
    frontierBudget: 3600,
    measuredTurns,
    noteHits: async () => {},
  });
  let h!: LifecycleHandlers;
  await registerHooks(
    {
      async register(handlers) {
        h = handlers;
        return { async dispose() {} };
      },
    },
    {
      ...identity,
      guarded,
      sessions,
      instanceDir: dir,
      budget: 1200,
      noteHits,
      measuredTurns,
      flushStatus: sessions.flushStatus,
      pullScope: PULL_SHIPPED,
      getCompactCapture: () => undefined,
    },
  );
  await appendMemory({
    type: "learning",
    scope: "fixture",
    content: FACT,
    repo: "global",
  });
  return { h, hits, sessions };
}

test("normalized lifecycle settles each session's receipts once before delivering context", async () => {
  const { h, hits } = await setup();
  const results = new Map<string, string>();
  for (const sid of ["normalized-a", "normalized-b"]) {
    await h.prompt({ sessionID: sid, text: "go" });
    await h.afterTool({
      sessionID: sid,
      callID: "same-call",
      tool: "read",
      args: {},
      text: FACT,
      metadata: {},
      appendResult(text) {
        results.set(sid, text);
        return true;
      },
    });
  }
  expect(hits).toEqual([]);
  const observed = (sid: string) => [
    { callID: "same-call", tool: "read", text: results.get(sid)! },
  ];
  await h.context({
    sessionID: "normalized-b",
    observedResults: observed("normalized-a"),
    appendSystem() {},
  });
  expect(hits).toEqual([]);
  const delivered: string[] = [];
  const request = {
    sessionID: "normalized-a",
    observedResults: observed("normalized-a"),
    appendSystem(text: string) {
      expect(hits.filter((hit) => hit.sid === "normalized-a")).toHaveLength(1);
      delivered.push(text);
    },
  };
  await Promise.all([h.context(request), h.context(request)]);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({
    source: "pull",
    sid: "normalized-a",
    at: { turn: 1 },
  });
  expect(hits[0].rows.map((row) => row.content)).toEqual([FACT]);
  expect(delivered.length).toBeGreaterThan(0);
  await h.context({
    sessionID: "normalized-b",
    observedResults: observed("normalized-b"),
  });
  expect(hits.map((hit) => hit.sid)).toEqual(["normalized-a", "normalized-b"]);
});

test("an absent context sink cannot count as a delivered request", async () => {
  const { h, sessions } = await setup();
  const sid = "normalized-no-sink";
  await h.prompt({
    sessionID: sid,
    text: "ERR_MODULE_NOT_FOUND vite.config.ts",
  });
  await h.context({ sessionID: sid, observedResults: [] });
  const before = await sessions.buildPayload(sid);
  expect(before?.stats?.requests).toBe(0);
  const text: string[] = [];
  await h.context({
    sessionID: sid,
    observedResults: [],
    appendSystem: (part) => {
      text.push(part);
    },
  });
  const after = await sessions.buildPayload(sid);
  expect(text.join("\n")).toContain(FACT);
  expect(after?.stats?.requests).toBe(1);
});
