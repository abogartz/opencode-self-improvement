import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createOhMyPiMemory } from "../../src/adapters/oh-my-pi/extension.ts";
import type {
  OmpContext,
  OmpEvents,
} from "../../src/adapters/oh-my-pi/context.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import { hitsFile } from "../../src/telemetry/ledger.ts";
import { readLines } from "../../src/core/logfmt/read.ts";
import { parseLine } from "../../src/core/logfmt/format.ts";
import { PULL_HEADER } from "../../src/inject/pull.ts";
import { withTempStore } from "../helpers/temp-store.ts";

const store = withTempStore({ prefix: "osi-omp-delivery-" });
const FACT =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
const QUERY = "azurite deployment stale manifest cobalt queue";

async function driver(options?: Record<string, unknown>) {
  const handlers = new Map<
    string,
    (event: any, ctx: OmpContext) => Promise<any>
  >();
  await createOhMyPiMemory({ options })({
    on: (name, handler) => {
      handlers.set(name, handler);
    },
    registerTool() {},
  });
  await appendMemory({
    type: "learning",
    scope: "azurite",
    content: FACT,
    repo: "global",
  });
  const emit = (name: string, event: unknown, sid = "reader") =>
    handlers.get(name)?.(event, {
      cwd: store.root,
      sessionManager: { getSessionId: () => sid },
    });
  return { emit, close: () => emit("session_shutdown", {}) };
}

function read(
  over: Partial<OmpEvents["tool_result"]> = {},
): OmpEvents["tool_result"] {
  return {
    toolName: "read",
    toolCallId: "read-1",
    input: { path: QUERY },
    content: [{ type: "text", text: "file contents" }],
    isError: false,
    ...over,
  };
}
function request(content: unknown, over: Record<string, unknown> = {}) {
  return {
    messages: [
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content,
        ...over,
      },
    ],
  };
}
async function credits() {
  return existsSync(hitsFile())
    ? (await readLines(hitsFile()))
        .map(parseLine)
        .filter((line) => line?.src === "pull")
    : [];
}

describe("oh-my-pi contextual delivery", () => {
  test("a mixed result keeps its original blocks and earns credit only in its own request", async () => {
    const d = await driver();
    try {
      const original = read({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "image-data", mimeType: "image/png" },
          { type: "text", text: "last" },
        ],
      });
      const before = structuredClone(original);
      const result = await d.emit("tool_result", original);
      expect(original).toEqual(before);
      expect(result?.content?.slice(0, 2)).toEqual(
        original.content.slice(0, 2),
      );
      expect(result?.content?.[2]?.text).toStartWith("last\n");
      expect(JSON.stringify(result?.content)).toInclude(PULL_HEADER);
      expect(JSON.stringify(result?.content)).toInclude(FACT);
      expect(result?.details).toBeUndefined();
      expect(result?.isError).toBeUndefined();
      expect(await credits()).toEqual([]);
      await d.emit("context", request(result.content), "other-session");
      await d.emit("context", request(result.content, { role: "user" }));
      await d.emit("context", request(result.content, { toolName: "grep" }));
      await d.emit(
        "context",
        request(result.content, { toolCallId: "wrong-call" }),
      );
      expect(await credits()).toEqual([]);
      await d.emit("context", request(result.content));
      await d.emit("context", request(result.content));
      expect(await credits()).toHaveLength(1);
    } finally {
      await d.close();
    }
  });

  test("a formatter that leaves the header but clips the row earns no credit", async () => {
    const d = await driver();
    try {
      const result = await d.emit("tool_result", read());
      expect(JSON.stringify(result?.content)).toInclude(FACT);
      const clipped = result.content.map((part: any) => ({
        ...part,
        text: part.text
          .split("\n")
          .filter((line: string) => !line.includes(FACT))
          .join("\n"),
      }));
      await d.emit("context", request(clipped));
      expect(await credits()).toEqual([]);
      // A settled clipped receipt cannot later be credited by replaying the original.
      await d.emit("context", request(result.content));
      expect(await credits()).toEqual([]);
    } finally {
      await d.close();
    }
  });

  test("transcript replacement cannot credit a pull from the previous generation", async () => {
    const d = await driver();
    try {
      const result = await d.emit("tool_result", read());
      expect(JSON.stringify(result?.content)).toInclude(FACT);
      await d.emit("session_clear", {});
      await d.emit("context", request(result.content));
      expect(await credits()).toEqual([]);
    } finally {
      await d.close();
    }
  });

  for (const [name, options, event, shown] of [
    [
      "default output matching",
      {},
      read({ input: {}, content: [{ type: "text", text: QUERY }] }),
      true,
    ],
    [
      "arguments-only setting",
      { pullOutputChars: 0 },
      read({ input: {}, content: [{ type: "text", text: QUERY }] }),
      false,
    ],
    ["explicit opt-out", { pullTools: [] }, read(), false],
    ["selected tools", { pullTools: ["grep"] }, read(), false],
    ["injection budget", { injectBudget: 1 }, read(), false],
    ["unselected shell", {}, read({ toolName: "bash" }), false],
    ["failed read", {}, read({ isError: true }), false],
    [
      "image-only read",
      {},
      read({
        content: [{ type: "image", data: "data", mimeType: "image/png" }],
      }),
      true,
    ],
  ] as const) {
    test(`${name} controls whether a result carries memory`, async () => {
      const d = await driver(options);
      try {
        const result = await d.emit("tool_result", event);
        expect(JSON.stringify(result ?? {}).includes(PULL_HEADER)).toBe(shown);
        if (!shown) expect(result).toBeUndefined();
        expect(await credits()).toEqual([]);
      } finally {
        await d.close();
      }
    });
  }
});
