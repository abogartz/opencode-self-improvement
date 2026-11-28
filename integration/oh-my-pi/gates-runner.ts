import assert from "node:assert/strict";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { createOhMyPiMemory } from "../../src/adapters/oh-my-pi/extension.ts";
import { readEvidenceLog } from "../../test/helpers/logfmt.ts";
import { openSession } from "./session.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import { resolveRepo } from "../../src/identity/repokey.ts";
import { PULL_HEADER } from "../../src/inject/pull.ts";

const [cwd, agentDir, baseUrl, stepsFile] = process.argv.slice(2);
const observed: Array<{ isError: boolean; details: unknown }> = [];
const fact =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
await appendMemory({
  type: "learning",
  scope: "azurite",
  content: fact,
  repo: resolveRepo(cwd).key,
});
const pulled: boolean[] = [];
const fixture: ExtensionFactory = async (pi) => {
  await createOhMyPiMemory({
    options: { autoCapture: false, pullTools: ["bash"] },
  })(pi);
  // Exercise the real tool dispatcher without depending on an installed shell.
  // These are the exit/error fields produced by the pinned native bash tool.
  pi.registerTool({
    name: "bash",
    label: "Scripted shell",
    description: "Return a scripted command exit",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, exitCode: { type: "number" } },
      required: ["command", "exitCode"],
    },
    async execute(_id, args) {
      if (!args || typeof args !== "object" || !("exitCode" in args))
        throw new Error("Missing scripted exit");
      const code = Number(args.exitCode);
      return {
        content: [
          {
            type: "text",
            text: "azurite deployment stale manifest cobalt queue",
          },
        ],
        details: { exitCode: code },
        isError: code !== 0,
      };
    },
  });
  pi.on("tool_result", async (event) => {
    if (event.toolName === "bash") {
      observed.push({ isError: event.isError, details: event.details });
      pulled.push(JSON.stringify(event.content).includes(PULL_HEADER));
    }
  });
};
const { session } = await openSession(cwd, agentDir, baseUrl, {
  extensions: [fixture],
});
try {
  const call = (code: number) => ({
    tool_calls: [
      {
        id: `gate-${code}`,
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "bun test", exitCode: code }),
        },
      },
    ],
  });
  await Bun.write(
    stepsFile,
    JSON.stringify({
      "GATES::turn": [call(1), call(0), { content: "Recovered." }],
    }),
  );
  await session.prompt(
    "GATES::turn Run the scripted failing test, then the passing test.",
  );
  assert.deepEqual(observed, [
    { isError: true, details: { exitCode: 1 } },
    { isError: false, details: { exitCode: 0 } },
  ]);
  const log = readEvidenceLog();
  assert.deepEqual(
    pulled,
    [false, true],
    "only successful shell results receive pulls",
  );
  assert.deepEqual(
    log.filter((e) => e.ev === "gate_check").map((e) => e.status),
    ["FAIL", "PASS"],
  );
  assert.ok(
    log.some(
      (e) => e.ev === "t4_learning" && e.from === "FAIL" && e.to === "PASS",
    ),
  );
  console.log("GATES-PASS");
} finally {
  await session.dispose();
}
