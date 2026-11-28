import assert from "node:assert/strict";
import { join } from "node:path";
import { openSession } from "./session.ts";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

const [cwd, agentDir, baseUrl, extensionPath] = process.argv.slice(2);
await Bun.write(
  join(cwd, "package.json"),
  JSON.stringify({
    name: "workflow-fixture",
    scripts: { test: "bun test", build: "bun build index.ts" },
  }),
);
const { session } = await openSession(cwd, agentDir, baseUrl, {
  extensionPath,
});
try {
  assert.equal(session.extensionRunner?.getCommand("memory"), undefined);
  assert.ok(session.extensionRunner?.getCommand("memory-report"));
  await session.prompt("/repo-init force");
  await session.prompt("/memory-report");
  let nativeMemory = false;
  const interactive = {
    ctx: {
      composer: { setText() {} },
      handleMemoryCommand: async () => {
        nativeMemory = true;
      },
    },
  } as unknown as Parameters<typeof executeBuiltinSlashCommand>[1];
  assert.equal(await executeBuiltinSlashCommand("/memory", interactive), true);
  assert.equal(nativeMemory, true);
  assert.equal(
    await executeBuiltinSlashCommand("/memory-report", interactive),
    false,
  );
  const messages = session.messages.filter(
    (message) => message.role === "custom",
  );
  const init = messages.find((message) => message.customType === "repo-init");
  assert.match(JSON.stringify(init?.content), /Initialized/);
  assert.match(JSON.stringify(init?.content), /npm run test/);
  const report = messages.find(
    (message) => message.customType === "memory-report",
  );
  assert.match(JSON.stringify(report?.content), /oh-my-pi/);
  assert.ok(!messages.some((message) => message.customType === "memory"));
  const requests = await (await fetch(new URL("/__requests", baseUrl))).json();
  assert.deepEqual(requests, [], "native commands must not start model turns");
  console.log("WORKFLOWS-PASS");
} finally {
  await session.dispose();
}
