import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import memory from "../../src/adapters/oh-my-pi/extension.ts";
import type { OmpAPI, OmpEvents } from "../../src/adapters/oh-my-pi/context.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { withStoreLock } from "../../src/store/lock.ts";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, stepsFile, scenario] = process.argv.slice(2);
const PROJECT =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
const OTHER =
  "When vermilion tooling reports an expired cache: refresh the shared cache using the saffron command before repeating the operation.";
const QUERY = "azurite deployment stale manifest cobalt queue";
const trace: string[] = [];
const preparationEntered = Promise.withResolvers<void>();
const preparationRelease = Promise.withResolvers<void>();
const writeEntered = Promise.withResolvers<void>();
const writeAborted = Promise.withResolvers<void>();
const shutdownEntered = Promise.withResolvers<void>();
let holdPreparation = false;
let watchWrite = false;

const probe: ExtensionFactory = async (pi) => {
  // Intercept our registrations, not host internals, while the real runner
  // still dispatches its own payloads, contexts, cancellation and shutdown.
  const host: OmpAPI = pi;
  const on: OmpAPI["on"] = (name, handler) => {
    host.on(name, async (event, ctx) => {
      trace.push(name);
      const work = handler(event as OmpEvents[typeof name], ctx);
      if (name === "session_shutdown") shutdownEntered.resolve();
      const result = await work;
      if (name === "session_shutdown") trace.push("shutdown.finished");
      if (name === "before_agent_start" && holdPreparation) {
        preparationEntered.resolve();
        await preparationRelease.promise;
      }
      return result;
    });
  };
  await memory({
    on,
    registerTool(tool) {
      pi.registerTool({
        ...tool,
        async execute(...args) {
          const watched = watchWrite && tool.name === "memory_remember";
          const work = tool.execute(...args);
          if (watched) {
            args[2]?.addEventListener("abort", () => writeAborted.resolve(), {
              once: true,
            });
            writeEntered.resolve();
          }
          const result = await work;
          if (watched) trace.push("write.finished");
          return result;
        },
      });
    },
  });
};
const { session } = await openSession(cwd, agentDir, baseUrl, {
  extensions: [probe],
  persistent: true,
});
function call(name: string, args: Record<string, unknown>) {
  return {
    tool_calls: [
      {
        id: crypto.randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}
async function prepare(steps: unknown[]) {
  await Bun.write(
    stepsFile,
    JSON.stringify({ "LIFE::turn": [...steps, { content: "LIFE-DONE" }] }),
  );
  await fetch(new URL("/__reset", baseUrl), { method: "POST" });
}
async function requests() {
  const all = (await (await fetch(new URL("/__requests", baseUrl))).json()) as {
    tools?: unknown[];
    messages: { role: string; content: unknown }[];
  }[];
  return all.filter((r) => r.tools?.length);
}
async function run(steps: unknown[], prompt = QUERY) {
  await prepare(steps);
  const before = session.messages.length;
  await session.prompt(`LIFE::turn ${prompt}`);
  const added = session.messages.slice(before);
  assert.match(JSON.stringify(added), /LIFE-DONE/);
  return added
    .filter((m) => m.role === "toolResult")
    .map((m) => JSON.stringify(m));
}
const remember = (content: string, scope: string, status = "settled") =>
  call("memory_remember", { type: "learning", scope, content, status });
const systemText = async () =>
  (await requests())[0]?.messages
    .filter((m) => ["system", "developer"].includes(m.role))
    .map((m) => String(m.content))
    .join("\n") ?? "";
async function seed() {
  await Bun.write(join(cwd, "observations.txt"), PROJECT);
  const result = await run([
    call("read", { path: join(cwd, "observations.txt") }),
    remember(PROJECT, "azurite"),
  ]);
  assert.match(result[1], /Remembered: learning in azurite/);
}
try {
  if (scenario === "transcripts") {
    await seed();
    await session.sessionManager.flush();
    const originalFile = session.sessionManager.getSessionFile();
    assert.ok(originalFile);
    const originalId = session.sessionManager.getSessionId();
    assert.equal(await session.newSession(), true);
    assert.notEqual(session.sessionManager.getSessionId(), originalId);
    assert.match(
      (await run([remember(OTHER, "vermilion")]))[0],
      /Write blocked at GATE/,
    );
    assert.equal(
      await session.switchSession(originalFile, { keepModel: true }),
      true,
    );
    assert.equal(session.sessionManager.getSessionId(), originalId);
    assert.match(
      (await run([remember(OTHER, "vermilion")]))[0],
      /Write blocked at GATE/,
    );
    // Establish fresh grounding again so clear has something real to retire.
    await run([call("read", { path: join(cwd, "observations.txt") })]);
    await session.resetSessionContext();
    assert.equal(session.sessionManager.getSessionId(), originalId);
    assert.match(
      (await run([remember(OTHER, "vermilion")]))[0],
      /Write blocked at GATE/,
    );
    assert.ok((await systemText()).includes(PROJECT));
    await session.compact();
    assert.ok(trace.includes("session_compact"));
    await run([call("memory_recall", { query: QUERY })]);
    assert.ok((await systemText()).includes(PROJECT));
    assert.ok(trace.includes("session_clear"));
    assert.equal(trace.filter((x) => x === "session_switch").length, 2);
  } else if (scenario === "aborted-preparation") {
    await seed();
    await session.newSession();
    await prepare([]);
    holdPreparation = true;
    const prompting = session.prompt(`LIFE::turn ${QUERY}`);
    await preparationEntered.promise;
    const aborting = session.abort();
    holdPreparation = false;
    preparationRelease.resolve();
    await Promise.all([prompting, aborting]);
    assert.equal((await requests()).length, 0);
    await run([], "Explain penguin migration.");
    assert.ok(
      !(await systemText()).includes(PROJECT),
      "aborted preparation must not freeze memory into an unrelated later request",
    );
    await run([], QUERY);
    assert.ok((await systemText()).includes(PROJECT));
  } else if (scenario === "pending-write") {
    await seed();
    const file = (await loadAll())[0]?.file;
    assert.ok(file);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = withStoreLock(file, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let prompting: Promise<unknown> | undefined;
    let aborting: Promise<void> | undefined;
    let disposing: Promise<void> | undefined;
    try {
      await prepare([remember(OTHER, "vermilion")]);
      watchWrite = true;
      prompting = session.prompt(`LIFE::turn ${QUERY}`);
      await writeEntered.promise;
      aborting = session.abort();
      await writeAborted.promise;
      disposing = session.dispose();
      await shutdownEntered.promise;
      release.resolve();
      await Promise.all([held, prompting, aborting, disposing]);
      assert.ok(
        (await loadAll()).some((m) => m.content === OTHER),
        "an admitted write remains durable after cancellation",
      );
      assert.ok(trace.includes("write.finished"));
      assert.ok(trace.includes("shutdown.finished"));
      assert.ok(
        trace.indexOf("write.finished") < trace.indexOf("shutdown.finished"),
      );
      await session.dispose();
      assert.equal(trace.filter((x) => x === "session_shutdown").length, 1);
    } finally {
      release.resolve();
      await Promise.allSettled([held, prompting, aborting, disposing]);
    }
  } else throw new Error(`Unknown lifecycle scenario: ${scenario}`);
} catch (error) {
  console.error("Lifecycle trace:", JSON.stringify(trace));
  throw error;
} finally {
  preparationRelease.resolve();
  await session.dispose();
  await Bun.write(join(agentDir, "lifecycle.json"), JSON.stringify(trace));
}
console.log(`LIFECYCLE-PASS ${scenario}`);
