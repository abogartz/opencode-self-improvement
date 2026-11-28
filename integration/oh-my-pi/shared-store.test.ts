import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  MEMORY_TOOLS,
  REPO,
  loadFailure,
  makeGuest,
  startFake,
  turn,
  type Fake,
  type Guest,
} from "../../e2e/support/harness.ts";

let fake: Fake;
const guests: Guest[] = [];
beforeAll(async () => {
  fake = await startFake({ requireUserMessage: true });
});
afterEach(() => {
  for (const g of guests.splice(0))
    rmSync(g.root, { recursive: true, force: true });
});
afterAll(() => fake.stop());

const PROJECT =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
const GLOBAL =
  "When vermilion tooling reports an expired cache: refresh the shared cache using the saffron command before repeating the operation.";
const PROJECT_UPDATED =
  "When azurite deployment reports a stale manifest: discard the old manifest and rebuild from the indigo archive before retrying the release.";
const GLOBAL_UPDATED =
  "When vermilion tooling reports an expired cache: recreate the cache from the amber catalog before repeating the operation.";
const QUERY =
  "azurite deployment stale manifest and vermilion tooling expired cache";
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
function guest() {
  const g = makeGuest(fake, REPO);
  guests.push(g);
  return g;
}
function outputs(messages: any[], name: string) {
  return messages
    .filter((m) => m.role === "toolResult" && m.toolName === name)
    .map((m) =>
      m.content
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n"),
    );
}
function sharedGuests() {
  const writer = guest();
  const peer = guest();
  const outsider = guest();
  peer.projDir = writer.projDir;
  for (const g of [peer, outsider]) {
    g.memoryDir = writer.memoryDir;
    g.env.OPENCODE_MEMORY_DIR = writer.memoryDir;
  }
  return { writer, peer, outsider };
}
async function initialSystem() {
  const request = (await fake.requests()).find((r: any) =>
    r.tools?.some((t: any) => t.function?.name === "memory_recall"),
  );
  expect(request).toBeDefined();
  expect(request.tools.map((t: any) => t.function.name)).toEqual(
    expect.arrayContaining(MEMORY_TOOLS),
  );
  return request.messages
    .filter((m: any) => ["system", "developer"].includes(m.role))
    .map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join("\n");
}

async function opencode(g: Guest, steps: unknown[], prompt = QUERY) {
  fake.setSteps({ "SHARE::turn": [...steps, { content: "SHARE-DONE" }] });
  const result = await turn(fake, g, `SHARE::turn ${prompt}`);
  expect(loadFailure(result)).toBeUndefined();
  expect(result.text()).toInclude("SHARE-DONE");
  expect(result.toolUses).toHaveLength(steps.length);
  expect(result.toolUses.every((use) => use.status === "completed")).toBe(true);
  return result;
}

async function omp(
  g: Guest,
  steps: unknown[],
  prompt = QUERY,
  captureReply?: unknown,
) {
  const agentDir = join(g.root, "omp");
  mkdirSync(agentDir, { recursive: true });
  fake.setSteps({
    "SHARE::turn": [
      ...steps,
      { content: "SHARE-DONE" },
      ...(captureReply === undefined ? [] : [captureReply]),
    ],
  });
  await fake.reset();
  const child = Bun.spawn(
    [
      process.execPath,
      join(
        import.meta.dir,
        captureReply === undefined ? "runner.ts" : "capture-runner.ts",
      ),
      g.projDir,
      agentDir,
      `http://127.0.0.1:${fake.port}/v1`,
      captureReply === undefined
        ? join(REPO, "src/adapters/oh-my-pi/extension.ts")
        : join(import.meta.dir, "capture-extension.ts"),
      `SHARE::turn ${prompt}`,
    ],
    {
      cwd: g.projDir,
      env: {
        ...g.env,
        USERPROFILE: g.env.HOME,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CONFIG_DIR: join(g.root, "omp-config"),
        OPENAI_API_KEY: "fake-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill(), 90_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0 || stderr.includes("extension runtime error"))
      throw new Error(`oh-my-pi exited ${exit}\n${stdout}\n${stderr}`);
    const messages = await Bun.file(join(agentDir, "messages.json")).json();
    expect(JSON.stringify(messages)).toInclude("SHARE-DONE");
    const results = messages.filter((m: any) => m.role === "toolResult");
    expect(results).toHaveLength(steps.length);
    expect(results.every((m: any) => !m.isError)).toBe(true);
    return { messages, system: await initialSystem(), stderr };
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
  }
}

async function seed(writer: Guest) {
  await Bun.write(
    join(writer.projDir, "observations.txt"),
    [PROJECT, GLOBAL, PROJECT_UPDATED, GLOBAL_UPDATED].join("\n"),
  );
  const seeded = await opencode(writer, [
    call("read", { path: join(writer.projDir, "observations.txt") }),
    call("memory_remember", {
      type: "learning",
      scope: "azurite",
      content: PROJECT,
      status: "settled",
    }),
    call("memory_remember", {
      type: "learning",
      scope: "vermilion",
      content: GLOBAL,
      status: "settled",
      global: true,
    }),
  ]);
  expect(seeded.outputs("memory_remember")).toEqual([
    "Remembered: learning in azurite",
    "Remembered: learning in vermilion",
  ]);
}

test("OpenCode and real oh-my-pi share project/global memory with project isolation and relevance selection", async () => {
  const { writer, peer, outsider } = sharedGuests();
  await seed(writer);
  const shared = await omp(peer, [
    call("memory_recall", { query: QUERY }),
    call("memory_status", {}),
  ]);
  const ompStats = outputs(shared.messages, "memory_status")[0];
  expect(ompStats).toInclude("HARNESS ACTIVITY");
  expect(ompStats).toInclude("opencode: credited retrievals");
  expect(ompStats).toInclude("oh-my-pi: credited retrievals");
  expect(shared.system).toInclude(PROJECT);
  expect(shared.system).toInclude(GLOBAL);
  expect(outputs(shared.messages, "memory_recall")[0]).toInclude(PROJECT);
  expect(outputs(shared.messages, "memory_recall")[0]).toInclude(GLOBAL);
  const foreign = await omp(outsider, [
    call("memory_recall", { query: QUERY }),
  ]);
  expect(foreign.system).not.toInclude(PROJECT);
  expect(foreign.system).toInclude(GLOBAL);
  expect(JSON.stringify(foreign.messages)).not.toInclude(PROJECT);
  const unrelated = await omp(peer, [], "Explain penguin migration.");
  expect(unrelated.system).not.toInclude(PROJECT);
  expect(unrelated.system).not.toInclude(GLOBAL);
  const reverse =
    "When indigo migration reports stale copper artifacts: rebuild the artifact index before enabling the pipeline.";
  await Bun.write(join(peer.projDir, "reverse.txt"), reverse);
  const written = await omp(
    peer,
    [
      call("read", { path: join(peer.projDir, "reverse.txt") }),
      call("memory_remember", {
        type: "learning",
        scope: "indigo",
        content: reverse,
        status: "settled",
      }),
    ],
    "indigo migration copper artifacts",
  );
  expect(outputs(written.messages, "memory_remember")).toEqual([
    "Remembered: learning in indigo",
  ]);
  const readBack = await opencode(writer, [
    call("memory_recall", { query: "indigo migration copper artifacts" }),
    call("memory_status", {}),
  ]);
  const ocStats = readBack.outputs("memory_status")[0];
  expect(ocStats).toInclude("opencode: credited retrievals");
  expect(ocStats).toInclude("oh-my-pi: credited retrievals");
  expect(readBack.outputs("memory_recall")[0]).toInclude(reverse);
}, 240_000);

test("corrections and deletions cross real harnesses while retaining project/global ownership", async () => {
  const { writer, peer, outsider } = sharedGuests();
  await seed(writer);
  const refused = await omp(outsider, [
    call("memory_update", {
      type: "learning",
      scope: "azurite",
      query: "cobalt queue",
      content: PROJECT_UPDATED,
    }),
    call("memory_forget", {
      type: "learning",
      scope: "azurite",
      reason: "Testing project isolation",
    }),
  ]);
  expect(outputs(refused.messages, "memory_update")[0]).toInclude(
    "memory_update blocked: no active learning row in azurite",
  );
  expect(outputs(refused.messages, "memory_forget")).toEqual([
    "No memories found for learning in azurite",
  ]);
  const changed = await omp(peer, [
    call("read", { path: join(peer.projDir, "observations.txt") }),
    call("memory_update", {
      type: "learning",
      scope: "azurite",
      query: "cobalt queue",
      content: PROJECT_UPDATED,
    }),
    call("memory_update", {
      type: "learning",
      scope: "vermilion",
      query: "saffron command",
      content: GLOBAL_UPDATED,
    }),
  ]);
  const changes = outputs(changed.messages, "memory_update");
  expect(changes[0]).toStartWith("Updated learning in azurite (superseded ");
  expect(changes[1]).toStartWith("Updated learning in vermilion (superseded ");
  const recalled = await opencode(writer, [
    call("memory_recall", { query: QUERY }),
  ]);
  for (const text of [
    recalled.outputs("memory_recall")[0],
    await initialSystem(),
  ]) {
    expect(text).toInclude(PROJECT_UPDATED);
    expect(text).toInclude(GLOBAL_UPDATED);
    expect(text).not.toInclude(PROJECT);
    expect(text).not.toInclude(GLOBAL);
  }
  const foreign = await omp(outsider, [
    call("memory_recall", { query: QUERY }),
  ]);
  for (const text of [
    outputs(foreign.messages, "memory_recall")[0],
    foreign.system,
  ]) {
    expect(text).toInclude(GLOBAL_UPDATED);
    expect(text).not.toInclude(PROJECT_UPDATED);
    expect(text).not.toInclude(GLOBAL);
  }
  const forgotten = await opencode(writer, [
    call("memory_forget", {
      type: "learning",
      scope: "azurite",
      reason: "Project procedure retired",
    }),
    call("memory_forget", {
      type: "learning",
      scope: "vermilion",
      reason: "Shared procedure retired",
    }),
  ]);
  // Forget includes both the superseded original and its active replacement.
  expect(forgotten.outputs("memory_forget")[0]).toStartWith(
    "Deleted 2 learning memory(s) from azurite.",
  );
  expect(forgotten.outputs("memory_forget")[1]).toStartWith(
    "Deleted 2 learning memory(s) from vermilion.",
  );
  for (const g of [peer, outsider]) {
    const after = await omp(g, [call("memory_recall", { query: QUERY })]);
    expect(outputs(after.messages, "memory_recall")).toEqual([
      "No memories found",
    ]);
    for (const row of [PROJECT, PROJECT_UPDATED, GLOBAL, GLOBAL_UPDATED])
      expect(after.system).not.toInclude(row);
  }
}, 240_000);

test("real oh-my-pi captures through a strict provider and OpenCode recalls the project row", async () => {
  const { writer, peer, outsider } = sharedGuests();
  const fact = "The nightly archive job keeps fourteen days of tarballs.";
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
  const privateTool = "PRIVATE-TOOL-CONTENT";
  await Bun.write(join(peer.projDir, "archive.txt"), `${fact}\n${privateTool}`);
  const completed = await omp(
    peer,
    [call("read", { path: join(peer.projDir, "archive.txt") })],
    `We finished the archive change. Remember that the nightly archive job keeps fourteen days of tarballs. The batch importer respects the staging rate limit per key, which matters while wiring the importer tooling. Temporary token ${secret}`,
    {
      content: JSON.stringify([
        { type: "context", scope: "batch", content: fact, status: "settled" },
      ]),
    },
  );
  const captures = (await fake.requests()).filter((r) =>
    JSON.stringify(r.messages?.[0]).includes(
      "You mine one coding-agent session transcript",
    ),
  );
  expect(captures, completed.stderr).toHaveLength(1);
  const request = captures[0];
  expect(request.model).toBe("scripted");
  expect(request.tools ?? []).toHaveLength(0);
  expect(request.messages.some((m: any) => m.role === "user")).toBe(true);
  expect(JSON.stringify(request)).not.toInclude(secret);
  expect(JSON.stringify(request)).not.toInclude(privateTool);
  expect(JSON.stringify(request)).toInclude(
    "nightly archive job keeps fourteen days",
  );
  const recalled = await opencode(writer, [
    call("memory_recall", { query: "nightly archive tarballs" }),
  ]);
  expect(recalled.outputs("memory_recall")[0]).toInclude(fact);
  const foreign = await omp(outsider, [
    call("memory_recall", { query: "nightly archive tarballs" }),
  ]);
  expect(JSON.stringify(foreign.messages)).not.toInclude(fact);
}, 240_000);

test("a tool-call capture response from the real SDK cannot create memory", async () => {
  const { writer, peer } = sharedGuests();
  await Bun.write(join(peer.projDir, "observations.txt"), PROJECT);
  await omp(
    peer,
    [call("read", { path: join(peer.projDir, "observations.txt") })],
    `Remember this verified project procedure: ${PROJECT} The deployment manifest controls which cobalt queue artifacts reach the release pipeline.`,
    call("memory_remember", {
      type: "learning",
      scope: "azurite",
      content: PROJECT,
      status: "settled",
    }),
  );
  const captures = (await fake.served()).filter((r) =>
    r.served.includes("#capture"),
  );
  expect(captures).toHaveLength(1);
  const recalled = await opencode(writer, [
    call("memory_recall", { query: QUERY }),
  ]);
  expect(recalled.outputs("memory_recall")).toEqual(["No memories found"]);
}, 240_000);
