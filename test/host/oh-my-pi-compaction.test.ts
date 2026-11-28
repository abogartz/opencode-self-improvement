import { expect, test } from "bun:test";
import memory from "../../src/adapters/oh-my-pi/extension.ts";
import type { OmpContext } from "../../src/adapters/oh-my-pi/context.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";
import { withTempStore } from "../helpers/temp-store.ts";

const store = withTempStore({ prefix: "osi-omp-compact-" });
const FACT =
  "The azurite release requires the cobalt manifest before deployment.";
async function driver() {
  const handlers = new Map<
    string,
    (event: any, ctx: OmpContext) => Promise<any>
  >();
  await memory({
    on: (name, handler) => {
      handlers.set(name, handler);
    },
    registerTool() {},
  });
  const emit = (name: string, event: unknown) =>
    handlers.get(name)?.(event, {
      cwd: store.root,
      sessionManager: { getSessionId: () => "reader" },
    });
  return { emit, close: () => emit("session_shutdown", {}) };
}
const rollups = () =>
  readEvidenceLog().filter((row) => row.ev === "t2_compaction");

test("oh-my-pi supplies summary context without rewriting messages or claiming a summary", async () => {
  const d = await driver();
  try {
    await appendMemory({
      type: "learning",
      scope: "azurite",
      content: FACT,
      repo: "global",
    });
    const event = {
      sessionId: "reader",
      messages: [{ role: "user", content: "Original request" }],
    };
    const before = structuredClone(event);
    const result = await d.emit("session.compacting", event);
    expect(result?.context).toHaveLength(1);
    expect(result?.context?.[0]).toInclude(FACT);
    expect(Object.keys(result)).toEqual(["context"]);
    expect(event).toEqual(before);
    expect(rollups()).toHaveLength(0);
    await d.emit("session_compact", { fromExtension: false });
    expect(rollups()).toHaveLength(1);
  } finally {
    await d.close();
  }
});

test("empty or mismatched compaction events cannot supply an anchor", async () => {
  const d = await driver();
  try {
    expect(
      await d.emit("session.compacting", { sessionId: "reader", messages: [] }),
    ).toBeUndefined();
    await appendMemory({
      type: "learning",
      scope: "azurite",
      content: FACT,
      repo: "global",
    });
    expect(
      await d.emit("session.compacting", {
        sessionId: "old-session",
        messages: [],
      }),
    ).toBeUndefined();
    expect(rollups()).toHaveLength(0);
    await d.close();
    expect(
      await d.emit("session.compacting", { sessionId: "reader", messages: [] }),
    ).toBeUndefined();
  } finally {
    await d.close();
  }
});

test("a host-provided summary still completes bookkeeping without preparation", async () => {
  const d = await driver();
  try {
    await d.emit("session_compact", { fromExtension: true });
    expect(rollups()).toHaveLength(1);
  } finally {
    await d.close();
  }
});
