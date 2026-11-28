import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { withTempStore } from "../helpers/temp-store.ts";
import { runScenario } from "./scenario.ts";
import { resolveRepo } from "../../src/identity/repokey.ts";
import { loadAll } from "../../src/store/files/load.ts";

const store = withTempStore({ prefix: "osi-reference-ports-" });
const row = {
  type: "context",
  scope: "archive",
  content:
    "The archive rollout will evaluate retention policies before the next deployment.",
  status: "open",
};

test("commands and tool registration can be held or failed before lifecycle admission", async () => {
  await runScenario("startup ports", async (s) => {
    const h = s.host("host", { directory: store.root });
    const commands = h.commands.pause("commands");
    const tools = h.toolRegistration.pause("tools");
    const start = h.start();
    const failed = start.then(
      () => undefined,
      (error) => error,
    );
    await commands.entered;
    expect(h.tools.size).toBe(0);
    commands.resolve();
    await tools.entered;
    expect(h.registration.calls).toHaveLength(0);
    tools.reject(new Error("registration refused"));
    expect(await failed).toBeInstanceOf(Error);
    expect((await failed).message).toBe("registration refused");
    expect(h.tools.size).toBe(0);
  });
});

test("held transcript identity wins over the session fallback for a real write", async () => {
  await runScenario("directory precedence", async (s) => {
    const a = join(store.root, "a");
    const b = join(store.root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const h = s.host("host", { directory: a });
    h.directories.set("writer", a);
    await h.start();
    const lookup = h.transcriptDirectoryReads.pause("identity");
    const write = h.invoke("writer", "memory_remember", row);
    expect(await lookup.entered).toBe("writer");
    expect(await loadAll()).toEqual([]);
    lookup.resolve(b);
    expect((await write).content).toStartWith("Remembered:");
    expect((await loadAll())[0]!.repo).toBe(resolveRepo(b).key);
    expect(h.sessionDirectoryReads.calls).toHaveLength(0);
  });
});

test("directory failures use the declared session fallback without inventing identity", async () => {
  await runScenario("directory fallback", async (s) => {
    const h = s.host("host", { directory: store.root });
    h.transcriptDirectoryReads.fail(new Error("transcript unavailable"));
    h.sessionDirectoryReads.reply(store.root);
    await h.start();
    expect(
      (await h.invoke("writer", "memory_remember", row)).content,
    ).toStartWith("Remembered:");
    expect(h.sessionDirectoryReads.calls).toEqual(["writer"]);
  });
});

test("capability profiles expose absent ports and suppress unavailable delivery", async () => {
  await runScenario("degraded host", async (s) => {
    const h = s.host("host", {
      directory: store.root,
      compaction: "unavailable",
      capabilities: {
        commands: false,
        defaultModel: false,
        transcriptDirectory: false,
        sessionDirectory: false,
        system: false,
        toolResults: false,
        observedToolResults: false,
        usageReceipts: false,
      },
    });
    const runtime = await h.start();
    expect(h.host.installCommands).toBeUndefined();
    expect(h.host.tools.directories.fromSession).toBeUndefined();
    expect(h.host.tools.directories.fromTranscript).toBeUndefined();
    expect(runtime.capabilities.capture.defaultModel).toBe(false);
    expect(runtime.capabilities.compaction).toBe("unavailable");
    const observed = { callID: "c", tool: "read", text: "visible" };
    expect(
      await h.context("reader", { observedResults: [observed] }),
    ).toMatchObject({ system: [], attemptedSystem: [], observedResults: [] });
    expect(h.commands.calls).toHaveLength(0);
  });
});

test("model resolution is session-specific and failures and missing models remain controllable", async () => {
  await runScenario("model resolution", async (s) => {
    const h = s.host("host", { directory: store.root });
    h.resolveModel = (sid) =>
      sid === "missing" ? null : { providerID: "fixture", id: String(sid) };
    expect(await h.host.capture.defaultModel!("one")).toEqual({
      providerID: "fixture",
      id: "one",
    });
    expect(await h.host.capture.defaultModel!("missing")).toBeNull();
    h.resolveModel = () => {
      throw new Error("model unavailable");
    };
    await expect(h.host.capture.defaultModel!("failed")).rejects.toThrow(
      "model unavailable",
    );
    expect(h.modelLookups).toEqual(["one", "missing", "failed"]);
  });
});

test("lifecycle errors reach diagnostics before cleanup and are dropped afterward", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await runScenario("error delivery", async (s) => {
      const h = s.host("host", { directory: store.root });
      await h.start();
      await h.emit("error", new Error("stream ended"));
      expect(warning).toHaveBeenCalledTimes(1);
      await h.dispose();
      await h.emit("error", new Error("late"));
      expect(warning).toHaveBeenCalledTimes(1);
    });
  } finally {
    warning.mockRestore();
  }
});

test("disposal during asynchronous model resolution prevents transcript reads and generation", async () => {
  await runScenario("dispose during model lookup", async (s) => {
    const h = s.host("host", {
      directory: store.root,
      options: { autoCapture: true },
    });
    await h.start();
    const model = h.modelReads.pause("default model");
    const turn = h.turnEnd("writer");
    expect(await model.entered).toBe("writer");
    const cleanup = h.dispose();
    model.resolve({ providerID: "fixture", id: "capture" });
    await Promise.all([cleanup, turn]);
    expect(h.transcriptReads.calls).toHaveLength(0);
    expect(h.generation.calls).toHaveLength(0);
    expect(await loadAll()).toEqual([]);
  });
});

test("capture cancels when a session moves away and back during transcript lookup", async () => {
  await runScenario("move during transcript lookup", async (s) => {
    const a = join(store.root, "a");
    const b = join(store.root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const h = s.host("host", { directory: a, options: { autoCapture: true } });
    const fact = "The nightly archive job keeps fourteen days of tarballs.";
    h.transcripts.set("writer", [
      {
        role: "user",
        text: `Remember that ${fact} The archive change is finished and the importer respects the staging limit. Remember the retention policy when wiring the archive importer and preparing the next deployment to the staging environment.`,
      },
    ]);
    await h.start();
    await h.ground("writer");
    const transcript = h.transcriptReads.pause("transcript lookup");
    const turn = h.turnEnd("writer");
    await transcript.entered;
    await h.move("writer", b);
    await h.move("writer", a);
    transcript.resolve([
      { role: "user", text: "Private project B facts. ".repeat(20) },
    ]);
    await turn;
    expect(h.generation.calls).toHaveLength(0);
    expect(await loadAll()).toEqual([]);
  });
});
