import assert from "node:assert/strict";
import { join } from "node:path";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, extensionPath] = process.argv.slice(2);
await Bun.write(
  join(cwd, "package.json"),
  JSON.stringify({
    name: "workflow-fixture",
    scripts: { test: "bun test", build: "bun build index.ts" },
  }),
);
const { session, runtime } = await openSession(cwd, agentDir, baseUrl, {
  extensionPath,
});
try {
  await session.prompt("/repo-init force");
  await session.prompt("/memory-report");
  await session.prompt("/memory");
  const messages = session.messages.filter(
    (message) => message.role === "custom",
  );
  const init = messages.find((message) => message.customType === "repo-init");
  assert.match(JSON.stringify(init?.content), /Initialized/);
  assert.match(JSON.stringify(init?.content), /npm run test/);
  const report = messages.find(
    (message) => message.customType === "memory-report",
  );
  assert.match(JSON.stringify(report?.content), /pi/);
  assert.ok(messages.some((message) => message.customType === "memory"));
  const requests = await (await fetch(new URL("/__requests", baseUrl))).json();
  assert.deepEqual(requests, [], "native commands must not start model turns");
  console.log("WORKFLOWS-PASS");
} finally {
  await runtime.dispose();
}
