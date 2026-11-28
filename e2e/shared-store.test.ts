// Independent OpenCode instances share durable rows through one store. These
// scenarios pin the visibility and mutation contracts future harness adapters
// must preserve; they do not claim that another harness is supported yet.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPO,
  loadFailure,
  makeGuest,
  startFake,
  turn,
  type Fake,
  type Guest,
} from "./support/harness.ts";

let fake: Fake;
const guests: Guest[] = [];

beforeAll(async () => {
  fake = await startFake();
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

function call(id: string, tool: string, args: Record<string, unknown>) {
  return {
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: tool, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function guest(): Guest {
  const g = makeGuest(fake, REPO);
  guests.push(g);
  writeFileSync(
    join(g.projDir, "observations.txt"),
    [PROJECT, GLOBAL, PROJECT_UPDATED, GLOBAL_UPDATED].join("\n"),
  );
  return g;
}

function sharedGuests() {
  const writer = guest();
  const peer = guest();
  const outsider = guest();
  // Separate homes, config/data directories, processes and sessions. Only
  // the memory root is shared; the peer also opens the writer's project.
  for (const g of [peer, outsider]) {
    g.memoryDir = writer.memoryDir;
    g.env.OPENCODE_MEMORY_DIR = writer.memoryDir;
  }
  peer.projDir = writer.projDir;
  return { writer, peer, outsider };
}

async function run(g: Guest, steps: Record<string, unknown>[], prompt = QUERY) {
  fake.setSteps({ "SHARE::turn": [...steps, { content: "SHARE-DONE" }] });
  const result = await turn(fake, g, `SHARE::turn ${prompt}`);
  expect(loadFailure(result)).toBeUndefined();
  expect(result.text()).toInclude("SHARE-DONE");
  expect(result.toolUses.every((use) => use.status === "completed")).toBe(true);
  expect(result.toolUses).toHaveLength(steps.length);
  return result;
}

function readObservations(g: Guest) {
  // A real read grounds settled memories through the normal write gate.
  return call("read", "read", { path: join(g.projDir, "observations.txt") });
}

async function seed(writer: Guest) {
  const result = await run(writer, [
    readObservations(writer),
    call("project", "memory_remember", {
      type: "learning",
      scope: "azurite",
      content: PROJECT,
      status: "settled",
    }),
    call("global", "memory_remember", {
      type: "learning",
      scope: "vermilion",
      content: GLOBAL,
      status: "settled",
      global: true,
    }),
  ]);
  expect(result.outputs("memory_remember")).toEqual([
    "Remembered: learning in azurite",
    "Remembered: learning in vermilion",
  ]);
}

async function recall(g: Guest) {
  const result = await run(g, [
    call("recall", "memory_recall", { query: QUERY }),
  ]);
  return result.outputs("memory_recall")[0];
}

async function initialSystemText() {
  // Inspect what the model received before it could call memory_recall.
  const request = (await fake.requests()).find(
    (body: any) => Array.isArray(body.tools) && body.tools.length > 0,
  );
  expect(request).toBeDefined();
  return (request.messages as { role: string; content: unknown }[])
    .filter((message) => ["system", "developer"].includes(message.role))
    .map((message) => String(message.content))
    .join("\n");
}

describe("Feature: shared memory across independent host instances", () => {
  test("Scenario: project visibility and global visibility still obey selection", async () => {
    const { writer, peer, outsider } = sharedGuests();
    await seed(writer);

    // Same project, new host installation: both rows are eligible for recall
    // and arrive in the initial model request when the prompt selects them.
    const shared = await recall(peer);
    expect(shared).toInclude(PROJECT);
    expect(shared).toInclude(GLOBAL);
    const selected = await initialSystemText();
    expect(selected).toInclude(PROJECT);
    expect(selected).toInclude(GLOBAL);

    // Sharing a store does not make every settled row an unconditional prompt.
    await run(peer, [], "Explain tessellation in abstract geometry.");
    const unrelated = await initialSystemText();
    expect(unrelated).not.toInclude(PROJECT);
    expect(unrelated).not.toInclude(GLOBAL);

    // An equally relevant prompt from another project can select only global
    // knowledge, through both the tool and automatic injection boundaries.
    const other = await recall(outsider);
    expect(other).not.toInclude(PROJECT);
    expect(other).toInclude(GLOBAL);
    const otherSystem = await initialSystemText();
    expect(otherSystem).not.toInclude(PROJECT);
    expect(otherSystem).toInclude(GLOBAL);
  }, 240_000);

  test("Scenario: corrections reach other instances without changing ownership", async () => {
    const { writer, peer, outsider } = sharedGuests();
    await seed(writer);

    const refused = await run(outsider, [
      readObservations(outsider),
      call("foreign", "memory_update", {
        type: "learning",
        scope: "azurite",
        query: "cobalt queue",
        content: PROJECT_UPDATED,
      }),
    ]);
    expect(refused.outputs("memory_update")[0]).toInclude(
      "memory_update blocked: no active learning row in azurite",
    );
    expect(await recall(writer)).toInclude(PROJECT);

    const changed = await run(peer, [
      readObservations(peer),
      call("project", "memory_update", {
        type: "learning",
        scope: "azurite",
        query: "cobalt queue",
        content: PROJECT_UPDATED,
      }),
      call("global", "memory_update", {
        type: "learning",
        scope: "vermilion",
        query: "saffron command",
        content: GLOBAL_UPDATED,
      }),
    ]);
    const updates = changed.outputs("memory_update");
    expect(updates[0]).toStartWith("Updated learning in azurite (superseded ");
    expect(updates[1]).toStartWith(
      "Updated learning in vermilion (superseded ",
    );

    const shared = await recall(writer);
    expect(shared).toInclude(PROJECT_UPDATED);
    expect(shared).toInclude(GLOBAL_UPDATED);
    expect(shared).not.toInclude(PROJECT);
    expect(shared).not.toInclude(GLOBAL);
    const selected = await initialSystemText();
    expect(selected).toInclude(PROJECT_UPDATED);
    expect(selected).toInclude(GLOBAL_UPDATED);
    expect(selected).not.toInclude(PROJECT);
    expect(selected).not.toInclude(GLOBAL);

    // Editing a global row inside a project must not make it project-local.
    const other = await recall(outsider);
    expect(other).toInclude(GLOBAL_UPDATED);
    expect(other).not.toInclude(PROJECT_UPDATED);
    expect(other).not.toInclude(GLOBAL);
    const otherSystem = await initialSystemText();
    expect(otherSystem).toInclude(GLOBAL_UPDATED);
    expect(otherSystem).not.toInclude(PROJECT_UPDATED);
  }, 240_000);

  test("Scenario: forgetting shared rows removes them from subsequent sessions", async () => {
    const { writer, peer, outsider } = sharedGuests();
    await seed(writer);
    const before = await recall(peer);
    expect(before).toInclude(PROJECT);
    expect(before).toInclude(GLOBAL);

    const refused = await run(outsider, [
      call("foreign", "memory_forget", {
        type: "learning",
        scope: "azurite",
        reason: "Testing repository isolation",
      }),
    ]);
    expect(refused.outputs("memory_forget")[0]).toBe(
      "No memories found for learning in azurite",
    );
    expect(await recall(writer)).toInclude(PROJECT);

    const forgotten = await run(peer, [
      call("project", "memory_forget", {
        type: "learning",
        scope: "azurite",
        reason: "The project procedure was retired",
      }),
      call("global", "memory_forget", {
        type: "learning",
        scope: "vermilion",
        reason: "The general procedure was retired",
      }),
    ]);
    const deletions = forgotten.outputs("memory_forget");
    expect(deletions[0]).toStartWith(
      "Deleted 1 learning memory(s) from azurite.",
    );
    expect(deletions[1]).toStartWith(
      "Deleted 1 learning memory(s) from vermilion.",
    );
    for (const g of [writer, outsider]) {
      expect(await recall(g)).toBe("No memories found");
      const system = await initialSystemText();
      expect(system).not.toInclude(PROJECT);
      expect(system).not.toInclude(GLOBAL);
    }
  }, 240_000);
});
