import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetCaptureCooldowns } from "../../src/runtime/capture.ts";
import { resetCaptureCursors } from "../../src/capture/policy.ts";
import { readFileSync } from "node:fs";
import { hitsFile } from "../../src/telemetry/ledger.ts";
import { parseLine } from "../../src/core/logfmt/format.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LifecycleHandlers } from "../../src/host/lifecycle.ts";
import type { MemorySetupOptions } from "../../src/host/runtime.ts";
import type { TestHost } from "../simulator/host.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";

/** Drivers translate stimuli only; every assertion exercises the shared engine. */
export interface RuntimeDriver {
  tools: TestHost["tools"];
  transcripts: TestHost["transcripts"];
  generation: {
    readonly calls: readonly { prompt: string }[];
    reply(value: string): void;
    pause(label: string): {
      entered: Promise<unknown>;
      resolve(value: string): void;
      reject(error: Error): void;
    };
  };
  invoke: TestHost["invoke"];
  request: TestHost["request"];
  context: TestHost["context"];
  ground: TestHost["ground"];
  turnEnd: TestHost["turnEnd"];
  emit<K extends keyof LifecycleHandlers>(
    name: K,
    event: Parameters<LifecycleHandlers[K]>[0],
  ): Promise<void>;
  dispose(): Promise<void>;
  close(): Promise<void>;
}

export type RuntimeDriverFactory = (
  config: MemorySetupOptions,
) => Promise<RuntimeDriver>;
const FACT =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
const GLOBAL =
  "When vermilion tooling reports an expired cache: refresh the shared cache using the saffron command before repeating the operation.";
const QUERY =
  "azurite deployment stale manifest and vermilion tooling expired cache";
const TOOLS = [
  "remember",
  "update",
  "forget",
  "recall",
  "list",
  "undo",
  "evidence",
  "merge_review",
  "export",
  "import",
  "decay",
  "consolidate",
  "init",
  "status",
]
  .map((n) => `memory_${n}`)
  .sort();

export function runtimeHostContract(
  create: RuntimeDriverFactory,
  store: { root: string },
  options: { promptDelivery?: "separate" | "combined" } = {},
) {
  const drivers: RuntimeDriver[] = [];
  beforeEach(() => {
    resetCaptureCooldowns();
    resetCaptureCursors();
  });
  afterEach(async () => {
    const results = await Promise.allSettled(
      drivers.splice(0).map((d) => d.close()),
    );
    const failures = results.flatMap((r) =>
      r.status === "rejected" ? [r.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Contract cleanup failed");
  });
  async function seat(
    project = "project",
    options: Record<string, unknown> = {},
  ) {
    const directory = join(store.root, project);
    mkdirSync(directory, { recursive: true });
    const driver = await create({
      directory,
      options: { autoCapture: false, ...options },
    });
    drivers.push(driver);
    return driver;
  }
  async function seed(d: RuntimeDriver) {
    await d.ground("writer");
    for (const [scope, content, global] of [
      ["azurite", FACT, false],
      ["vermilion", GLOBAL, true],
    ] as const) {
      expect(
        (
          await d.invoke("writer", "memory_remember", {
            type: "learning",
            scope,
            content,
            global,
            status: "settled",
          })
        ).content,
      ).toStartWith("Remembered:");
    }
  }

  test("all fourteen tools retain schemas, validate raw arguments and return text", async () => {
    const d = await seat();
    expect([...d.tools.keys()].sort()).toEqual(TOOLS);
    for (const [name, tool] of d.tools) {
      expect(tool.input).toMatchObject({ type: "object" });
      const properties = tool.input.properties as Record<string, unknown>;
      const field = Object.keys(properties ?? {})[0];
      const response = await d.invoke(
        "invalid",
        name,
        field ? { [field]: {} } : {},
      );
      if (field) expect(response.content).toStartWith("invalid arguments");
      else expect(typeof response.content).toBe("string");
    }
    expect(await loadAll()).toEqual([]);
  });

  test("grounding, shared project/global storage and automatic selection preserve ownership", async () => {
    const writer = await seat();
    const blocked = await writer.invoke("writer", "memory_remember", {
      type: "learning",
      scope: "azurite",
      content: FACT,
      status: "settled",
    });
    expect(blocked.content).toInclude("Write blocked at GATE");
    await seed(writer);
    const peer = await seat();
    const outsider = await seat("other");
    expect(
      (await peer.invoke("peer", "memory_recall", { query: QUERY })).content,
    ).toInclude(FACT);
    const selected = await peer.request("relevant", QUERY);
    expect(selected).toInclude(FACT);
    expect(selected).toInclude(GLOBAL);
    const foreign = await outsider.request("foreign", QUERY);
    expect(foreign).not.toInclude(FACT);
    expect(foreign).toInclude(GLOBAL);
    const unrelated = await peer.request(
      "unrelated",
      "Explain penguin migration.",
    );
    expect(unrelated).not.toInclude(FACT);
    expect(unrelated).not.toInclude(GLOBAL);
  });

  test("identity changes affect later calls without borrowing another project's rows", async () => {
    const d = await seat();
    await seed(d);
    const other = join(store.root, "moved");
    mkdirSync(other);
    await d.emit("identity", { sessionID: "writer", directory: other });
    const recalled = (
      await d.invoke("writer", "memory_recall", { query: QUERY })
    ).content;
    expect(recalled).not.toInclude(FACT);
    expect(recalled).toInclude(GLOBAL);
  });

  test("session-only facts reach their author's context and expire at compaction", async () => {
    const writer = await seat();
    await writer.ground("writer");
    const result = await writer.invoke("writer", "memory_remember", {
      type: "learning",
      scope: "azurite",
      content: FACT,
      session: true,
    });
    expect(result.content).toStartWith("Kept for this session only:");
    expect(await writer.request("writer", QUERY)).toInclude(FACT);
    expect(await writer.request("other-session", QUERY)).not.toInclude(FACT);
    const peer = await seat();
    expect(await peer.request("writer", QUERY)).not.toInclude(FACT);
    expect(await loadAll()).toEqual([]);
    await writer.emit("compact", {
      sessionID: "writer",
      transcript: undefined,
    });
    expect(await writer.request("writer", QUERY)).not.toInclude(FACT);
  });

  test("missing context sinks do not deliver and compaction supplies a memory anchor", async () => {
    const d = await seat();
    await seed(d);
    // Some hosts deliver system context in the prompt hook itself. Their
    // observation-only context hook cannot accept a pending system digest.
    if (options.promptDelivery !== "combined")
      await d.emit("prompt", { sessionID: "reader", text: QUERY });
    const missing = await d.context("reader", { system: false });
    expect(missing.system).toEqual([]);
    expect(missing.attemptedSystem).toEqual([]);
    const delivered =
      options.promptDelivery === "combined"
        ? await d.request("reader", QUERY)
        : (await d.context("reader")).system.join("\n");
    expect(delivered).toInclude(FACT);
    const anchor: string[] = [];
    await d.emit("compact", {
      sessionID: "reader",
      transcript: undefined,
      appendSystem: (text) => anchor.push(text),
    });
    expect(anchor.join("\n")).toInclude(FACT);
  });

  test("usage revisions replace cumulative totals instead of adding them", async () => {
    const d = await seat();
    for (const input of [7, 11, 11]) {
      await d.emit("usage", {
        sessionID: "usage",
        input,
        read: 3,
        write: 2,
        output: 5,
        reasoning: 1,
        cumulative: true,
      });
    }
    const observed = readEvidenceLog().filter((e) => e.ev === "session_usage");
    expect(observed).toHaveLength(3);
    expect(observed.at(-1)).toMatchObject({
      input: "11",
      read: "3",
      write: "2",
      output: "5",
      reasoning: "1",
    });
  });

  test("tool-result delivery is credited only after an intact request observation", async () => {
    const d = await seat();
    await seed(d);
    await d.emit("prompt", { sessionID: "reader", text: QUERY });
    const hits = () =>
      readFileSync(hitsFile(), "utf8")
        .split("\n")
        .map(parseLine)
        .filter((row) => row?.ev === "memory_used" && row.src === "pull");
    async function placement(callID: string) {
      let text = FACT;
      await d.emit("beforeTool", { sessionID: "reader", callID, tool: "read" });
      await d.emit("afterTool", {
        sessionID: "reader",
        callID,
        tool: "read",
        args: {},
        text,
        metadata: {},
        appendResult: (after) => {
          text = after;
          return true;
        },
      });
      expect(text).toInclude("Related durable memory");
      return { callID, tool: "read", text };
    }
    const clipped = await placement("clipped");
    await d.context("reader", {
      observedResults: [{ ...clipped, text: FACT }],
    });
    expect(hits()).toHaveLength(0);
    const full = await placement("full");
    await d.context("reader", { observedResults: [full, full] });
    const credited = hits().length;
    expect(credited).toBeGreaterThan(0);
    await d.context("reader", { observedResults: [full] });
    expect(hits()).toHaveLength(credited);
  });

  test("turn-end capture uses the shared write gate and sanitized isolated prompt", async () => {
    const d = await seat("project", { autoCapture: true });
    await d.ground("capture");
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    d.transcripts.set("capture", [
      {
        role: "user",
        text: `Remember this verified procedure: ${FACT} The deployment manifest controls which artifacts reach the release pipeline. Temporary token ${secret}`,
      },
    ]);
    d.generation.reply(
      JSON.stringify([
        {
          type: "learning",
          scope: "azurite",
          content: FACT,
          status: "settled",
        },
      ]),
    );
    await d.turnEnd("capture");
    expect(d.generation.calls).toHaveLength(1);
    expect(d.generation.calls[0]!.prompt).not.toInclude(secret);
    expect(d.generation.calls[0]!.prompt).toInclude("cobalt queue");
    expect((await loadAll()).map((r) => r.content)).toContain(FACT);
  });

  test("cleanup rejects late capture results and stops new lifecycle delivery", async () => {
    const d = await seat("project", { autoCapture: true });
    await d.ground("capture");
    d.transcripts.set("capture", [
      {
        role: "user",
        text: `Remember this verified procedure: ${FACT} The deployment manifest controls which artifacts reach the release pipeline.`,
      },
    ]);
    const model = d.generation.pause("late capture");
    const turn = d.turnEnd("capture");
    await model.entered;
    const cleanup = d.dispose();
    // A cooperative host may allow a bounded grace period. The answer here is
    // late even for that host: it arrives only after disposal has completed.
    await cleanup;
    model.resolve(
      JSON.stringify([
        {
          type: "learning",
          scope: "azurite",
          content: FACT,
          status: "settled",
        },
      ]),
    );
    await Promise.all([cleanup, turn]);
    expect(await loadAll()).toEqual([]);
    const before = readEvidenceLog();
    expect(await d.request("late", QUERY)).toBe("");
    await d.emit("compact", { sessionID: "capture", transcript: undefined });
    expect(readEvidenceLog()).toEqual(before);
    await d.dispose();
  });
}
