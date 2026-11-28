import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  MemoryToolHost,
  ToolCallContext,
} from "../../src/host/contracts.ts";
import { createSessionContext } from "../../src/identity/session-context.ts";
import { createInjectionEpochs } from "../../src/inject/epochs.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { registerMemoryTools } from "../../src/tools/registry.ts";

export interface ToolDriver {
  host: MemoryToolHost;
  invoke(
    name: string,
    args: unknown,
    context: ToolCallContext,
  ): Promise<{ content: string }>;
}

/** Shared behavior required of every adapter's tool/identity implementation. */
export function toolHostContract(
  create: (directory: string) => ToolDriver,
  store: { root: string },
) {
  async function seat(directory: string, sessionID: string) {
    const driver = create(directory);
    const identity = createSessionContext(driver.host.directories, {
      instanceDir: directory,
      liveRoot: directory,
    });
    const sessions = createInjectionEpochs({
      budget: 1200,
      frontierBudget: 3600,
      measuredTurns: new Map(),
      noteHits: async () => {},
    });
    await driver.host.registerTools((editor) =>
      registerMemoryTools(editor, {
        ...identity,
        sessions,
        noteHits: async () => {},
      }),
    );
    let calls = 0;
    return (name: string, args: unknown) =>
      driver.invoke(name, args, {
        sessionID,
        callID: `${sessionID}-${++calls}`,
      });
  }

  test("shared tools enforce write gates, project ownership and global visibility", async () => {
    const project = join(store.root, "project");
    const otherProject = join(store.root, "other-project");
    mkdirSync(project);
    mkdirSync(otherProject);
    const writer = await seat(project, "contract-writer");
    const peer = await seat(project, "contract-peer");
    const outsider = await seat(otherProject, "contract-outsider");

    const projectRow = {
      type: "context",
      scope: "azurite",
      content:
        "The azurite rollout will evaluate cobalt manifests before enabling the release queue.",
      status: "open",
    };
    const globalRow = {
      type: "context",
      scope: "vermilion",
      content:
        "The vermilion handbook will compare saffron cache policies across every workspace.",
      status: "open",
      global: true,
    };
    const malformed = await writer("memory_remember", {
      ...projectRow,
      global: "false",
    });
    expect(malformed.content).toStartWith("invalid arguments");
    expect(await loadAll()).toHaveLength(0);
    const ungrounded = await writer("memory_remember", {
      ...projectRow,
      status: "settled",
    });
    expect(ungrounded.content).toInclude(
      "Write blocked at GATE (ambiguous_memory)",
    );
    expect(await loadAll()).toHaveLength(0);

    expect((await writer("memory_remember", projectRow)).content).toStartWith(
      "Remembered:",
    );
    expect((await writer("memory_remember", globalRow)).content).toStartWith(
      "Remembered:",
    );
    const shared = (await peer("memory_recall", {})).content;
    expect(shared).toInclude(projectRow.content);
    expect(shared).toInclude(globalRow.content);
    const foreign = (await outsider("memory_recall", {})).content;
    expect(foreign).not.toInclude(projectRow.content);
    expect(foreign).toInclude(globalRow.content);

    const changed =
      "The azurite rollout will use indigo manifests after a staged review of the release queue.";
    const update = {
      scope: projectRow.scope,
      type: projectRow.type,
      query: "cobalt manifests",
      content: changed,
    };
    expect((await outsider("memory_update", update)).content).toInclude(
      "no active context row",
    );
    expect((await peer("memory_update", update)).content).toStartWith(
      "Updated context in azurite",
    );
    const corrected = (await writer("memory_recall", {})).content;
    expect(corrected).toInclude(changed);
    expect(corrected).not.toInclude(projectRow.content);
    expect((await outsider("memory_recall", {})).content).not.toInclude(
      changed,
    );

    const forget = {
      scope: projectRow.scope,
      type: projectRow.type,
      reason: "The rollout is retired",
    };
    expect((await outsider("memory_forget", forget)).content).toStartWith(
      "No memories found",
    );
    expect((await peer("memory_forget", forget)).content).toStartWith(
      "Deleted 2 context memory(s)",
    );
    const remaining = (await writer("memory_recall", {})).content;
    expect(remaining).not.toInclude(changed);
    expect(remaining).toInclude(globalRow.content);
  });
}
