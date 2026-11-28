import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "../../src/store/files/load.ts";
import { withStoreLock } from "../../src/store/lock.ts";
import extension from "../../src/adapters/oh-my-pi/extension.ts";
import type {
  OmpAPI,
  OmpContext,
  OmpEvents,
  OmpTool,
} from "../../src/adapters/oh-my-pi/context.ts";
import { withTempStore } from "../helpers/temp-store.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";

const store = withTempStore({ prefix: "osi-omp-" });
const PROJECT =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
const GLOBAL =
  "When vermilion tooling reports an expired cache: refresh the shared cache using the saffron command before repeating the operation.";
const QUERY =
  "azurite deployment stale manifest and vermilion tooling expired cache";

async function driver(cwd: string) {
  const handlers = new Map<string, (event: any, ctx: OmpContext) => unknown>();
  const tools = new Map<string, OmpTool>();
  const api: OmpAPI = {
    on: (name, handler) => {
      handlers.set(name, handler);
    },
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
  };
  await extension(api);
  const context = (sid: string): OmpContext => ({
    cwd,
    sessionManager: { getSessionId: () => sid },
  });
  const emit = async <K extends keyof OmpEvents>(
    name: K,
    event: OmpEvents[K],
    sid = "same-id",
  ) => handlers.get(name)?.(event, context(sid));
  return {
    tools,
    context,
    emit,
    async invoke(
      name: string,
      args: unknown,
      sid = "same-id",
      signal?: AbortSignal,
    ) {
      const result = await tools
        .get(name)!
        .execute("call", args, signal, undefined, context(sid));
      return result.content.map((p) => p.text).join("\n");
    },
    async prompt(text: string, sid: string) {
      const event = {
        reason: "prompt" as const,
        prompt: text,
        systemPrompt: ["Host instructions"],
      };
      const result = (await emit("before_agent_start", event, sid)) as {
        systemPrompt: string[];
      };
      expect(event.systemPrompt).toEqual(["Host instructions"]);
      return result.systemPrompt.join("\n");
    },
    close: () => emit("session_shutdown", {}),
  };
}

describe("oh-my-pi adapter", () => {
  test("failed shell exits retain gate failure and recovery evidence", async () => {
    const d = await driver(store.root);
    try {
      for (const [callID, exitCode, isError] of [
        ["failed", 1, true],
        ["passed", 0, false],
      ] as const) {
        await d.emit("tool_result", {
          toolName: "bash",
          toolCallId: callID,
          input: { command: "bun test" },
          content: [{ type: "text", text: "test runner finished" }],
          details: { exitCode },
          isError,
        });
      }
      const log = readEvidenceLog();
      expect(
        log.filter((e) => e.ev === "gate_check").map((e) => e.status),
      ).toEqual(["FAIL", "PASS"]);
      expect(log.find((e) => e.ev === "t4_learning")).toMatchObject({
        from: "FAIL",
        to: "PASS",
        gate: "bash:test",
      });
    } finally {
      await d.close();
    }
  });

  test("shell errors without a trustworthy failing exit cannot become passing gates", async () => {
    const d = await driver(store.root);
    try {
      for (const details of [
        {},
        { exitCode: 0 },
        { exitCode: "1" },
        { exitCode: Number.NaN },
      ]) {
        await d.emit("tool_result", {
          toolName: "bash",
          toolCallId: "unexecuted",
          input: { command: "bun test" },
          content: [{ type: "text", text: "interrupted" }],
          details,
          isError: true,
        });
      }
      expect(readEvidenceLog().filter((e) => e.ev === "gate_check")).toEqual(
        [],
      );
    } finally {
      await d.close();
    }
  });
  for (const boundary of [
    "session_clear",
    "session_switch",
    "session_tree",
    "session_branch",
  ] as const) {
    test(`${boundary} retires grounding even when the host session ID is reused`, async () => {
      const d = await driver(store.root);
      try {
        await d.emit("tool_result", {
          toolName: "read",
          toolCallId: "old-read",
          input: {},
          content: [{ type: "text", text: PROJECT }],
          isError: false,
        });
        expect(
          await d.invoke("memory_remember", {
            type: "learning",
            scope: "azurite",
            content: PROJECT,
            status: "settled",
          }),
        ).toStartWith("Remembered:");
        await d.emit(boundary, {});
        expect(await d.invoke("memory_recall", { query: QUERY })).toInclude(
          PROJECT,
        );
        expect(
          await d.invoke("memory_remember", {
            type: "learning",
            scope: "vermilion",
            content: GLOBAL,
            status: "settled",
          }),
        ).toInclude("Write blocked at GATE");
        expect(await d.prompt(QUERY, "same-id")).toInclude(PROJECT);
      } finally {
        await d.close();
      }
    });
  }

  test("shutdown during initialization waits until setup has settled", async () => {
    const handlers = new Map<string, () => Promise<unknown>>();
    const tools: OmpTool[] = [];
    const ctx = {
      cwd: store.root,
      sessionManager: { getSessionId: () => "startup" },
    };
    const events: string[] = [];
    const started = extension({
      on: (name, handler) => {
        handlers.set(name, () => handler({} as never, ctx));
      },
      registerTool: (tool) => {
        tools.push(tool);
      },
    }).then(() => {
      events.push("initialized");
    });
    const stopped = handlers.get("session_shutdown")!().then(() => {
      events.push("shutdown");
    });
    await Promise.all([started, stopped]);
    expect(events).toEqual(["initialized", "shutdown"]);
    await expect(
      tools[0]!.execute("late", {}, undefined, undefined, ctx),
    ).rejects.toThrow("closed");
  });

  test("compaction rebuilds frozen context to include the session's newer durable memory", async () => {
    const d = await driver(store.root);
    try {
      await d.emit("tool_result", {
        toolName: "read",
        toolCallId: "read",
        input: {},
        content: [{ type: "text", text: PROJECT }],
        isError: false,
      });
      expect(
        await d.invoke("memory_remember", {
          type: "learning",
          scope: "azurite",
          content: PROJECT,
          status: "settled",
        }),
      ).toStartWith("Remembered:");
      expect(await d.prompt(QUERY, "same-id")).toInclude(PROJECT);
      expect(
        await d.invoke("memory_remember", {
          type: "learning",
          scope: "vermilion",
          content: GLOBAL,
          status: "settled",
        }),
      ).toStartWith("Remembered:");
      expect(await d.prompt(QUERY, "same-id")).not.toInclude(GLOBAL);
      await d.emit("session_compact", {});
      const refreshed = await d.prompt(QUERY, "same-id");
      expect(refreshed).toInclude(PROJECT);
      expect(refreshed).toInclude(GLOBAL);
    } finally {
      await d.close();
    }
  });

  test("shutdown drains an admitted write after cancellation and rejects new calls", async () => {
    const d = await driver(store.root);
    const release = Promise.withResolvers<void>();
    let held: Promise<void> | undefined;
    let writing: Promise<unknown> | undefined;
    let closing: Promise<unknown> | undefined;
    try {
      await d.emit("tool_result", {
        toolName: "read",
        toolCallId: "read",
        input: {},
        content: [{ type: "text", text: PROJECT }],
        isError: false,
      });
      await d.invoke("memory_remember", {
        type: "learning",
        scope: "azurite",
        content: PROJECT,
        status: "settled",
      });
      const file = (await loadAll())[0]!.file;
      const entered = Promise.withResolvers<void>();
      held = withStoreLock(file, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const events: string[] = [];
      const abort = new AbortController();
      writing = d
        .invoke(
          "memory_remember",
          {
            type: "learning",
            scope: "vermilion",
            content: GLOBAL,
            status: "settled",
          },
          "same-id",
          abort.signal,
        )
        .then((result) => {
          events.push("write");
          expect(result).toStartWith("Remembered:");
        });
      abort.abort();
      closing = d.close().then(() => {
        events.push("shutdown");
      });
      await expect(d.invoke("memory_recall", {})).rejects.toThrow("closed");
      release.resolve();
      await Promise.all([held, writing, closing]);
      expect(events).toEqual(["write", "shutdown"]);
      expect((await loadAll()).some((m) => m.content === GLOBAL)).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([held, writing, closing]);
      await d.close();
    }
  });

  test("real tools share rows, isolate colliding host session IDs, and select visible context", async () => {
    const project = join(store.root, "project");
    const other = join(store.root, "other");
    mkdirSync(project);
    mkdirSync(other);
    const writer = await driver(project);
    const peer = await driver(project);
    const outsider = await driver(other);
    try {
      expect(writer.tools.size).toBe(14);
      expect(writer.tools.get("memory_remember")!.parameters.type).toBe(
        "object",
      );
      await writer.emit("tool_result", {
        toolName: "read",
        toolCallId: "read",
        input: {},
        content: [{ type: "text", text: PROJECT }],
        isError: false,
      });
      expect(
        await outsider.invoke("memory_remember", {
          type: "learning",
          scope: "azurite",
          content: PROJECT,
          status: "settled",
        }),
      ).toInclude("Write blocked at GATE");
      for (const [content, scope, global] of [
        [PROJECT, "azurite", false],
        [GLOBAL, "vermilion", true],
      ] as const) {
        expect(
          await writer.invoke("memory_remember", {
            type: "learning",
            scope,
            content,
            status: "settled",
            global,
          }),
        ).toStartWith("Remembered:");
      }
      expect(await peer.invoke("memory_recall", { query: QUERY })).toInclude(
        PROJECT,
      );
      const foreign = await outsider.invoke("memory_recall", { query: QUERY });
      expect(foreign).not.toInclude(PROJECT);
      expect(foreign).toInclude(GLOBAL);
      expect(await peer.prompt(QUERY, "relevant")).toInclude(PROJECT);
      expect(await peer.prompt("penguin migration", "unrelated")).not.toInclude(
        PROJECT,
      );
      const selected = await outsider.prompt(QUERY, "relevant");
      expect(selected).not.toInclude(PROJECT);
      expect(selected).toInclude(GLOBAL);
    } finally {
      await Promise.all([writer.close(), peer.close(), outsider.close()]);
    }
  });

  test("failed reads do not ground writes and malformed arguments still fail validation", async () => {
    const d = await driver(store.root);
    try {
      await d.emit("tool_result", {
        toolName: "read",
        toolCallId: "read",
        input: {},
        content: [{ type: "text", text: PROJECT }],
        isError: true,
      });
      const row = {
        type: "learning",
        scope: "azurite",
        content: PROJECT,
        status: "settled",
      };
      expect(await d.invoke("memory_remember", row)).toInclude(
        "Write blocked at GATE",
      );
      expect(
        await d.invoke("memory_remember", { ...row, global: "false" }),
      ).toStartWith("invalid arguments");
    } finally {
      await d.close();
    }
  });

  test("missing identity and late or aborted calls fail closed", async () => {
    const d = await driver("");
    const tool = d.tools.get("memory_recall")!;
    await expect(
      tool.execute("call", {}, undefined, undefined, d.context("sid")),
    ).rejects.toThrow("identity");
    await d.close();
    await d.close();
    expect(
      await d.emit("before_agent_start", {
        reason: "prompt",
        prompt: QUERY,
        systemPrompt: [],
      }),
    ).toBeUndefined();
    await expect(d.invoke("memory_remember", {})).rejects.toThrow("closed");
    const live = await driver(store.root);
    try {
      await expect(
        live.tools
          .get("memory_remember")!
          .execute(
            "call",
            {},
            AbortSignal.abort(),
            undefined,
            live.context("sid"),
          ),
      ).rejects.toThrow();
      expect(
        await live.emit("before_agent_start", {
          reason: "revive",
          prompt: "",
          systemPrompt: [],
        }),
      ).toBeUndefined();
    } finally {
      await live.close();
    }
  });

  test("partial registration failure leaves already registered tools inert", async () => {
    const tools: OmpTool[] = [];
    const handlers = new Map<
      string,
      (event: any, ctx: OmpContext) => unknown
    >();
    await expect(
      extension({
        on: (name, handler) => {
          handlers.set(name, handler);
        },
        registerTool: (tool) => {
          if (tools.length === 3) throw new Error("registration refused");
          tools.push(tool);
        },
      }),
    ).rejects.toThrow("registration refused");
    expect(tools).toHaveLength(3);
    const ctx = {
      cwd: store.root,
      sessionManager: { getSessionId: () => "partial" },
    };
    for (const tool of tools)
      await expect(
        tool.execute("late", {}, undefined, undefined, ctx),
      ).rejects.toThrow("closed");
    await handlers.get("session_shutdown")?.({}, ctx);
  });
});
