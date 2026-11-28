import assert from "node:assert/strict";
import { join } from "node:path";
import { createPiMemory } from "../../src/adapters/pi/extension.ts";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, stepsFile, scenario] = process.argv.slice(2);
const memory = createPiMemory({ options: { autoCapture: false } });
const opened = await openSession(cwd, agentDir, baseUrl, {
  extensions: [memory],
  persistent: true,
});
const call = (name: string, args: unknown) => ({
  tool_calls: [
    {
      id: crypto.randomUUID(),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const remember = (content: string) =>
  call("memory_remember", {
    type: "learning",
    scope: "azurite",
    content,
    status: "settled",
  });
const FACT =
  "When azurite deployment reports a stale manifest: rebuild using the cobalt queue before retrying.";
const OTHER =
  "When vermilion deploy fails to authenticate: refresh the saffron token before restarting the release.";
async function run(steps: unknown[]) {
  await Bun.write(
    stepsFile,
    JSON.stringify({ "LIFE::turn": [...steps, { content: "LIFE-DONE" }] }),
  );
  await fetch(new URL("/__reset", baseUrl), { method: "POST" });
  const offset = opened.session.messages.length;
  await opened.session.prompt(
    "LIFE::turn azurite deployment stale manifest cobalt queue",
  );
  return opened.session.messages
    .slice(offset)
    .filter((m) => m.role === "toolResult")
    .map((m) => JSON.stringify(m.content));
}
try {
  await Bun.write(join(cwd, "observations.txt"), FACT);
  const saved = await run([
    call("read", { path: join(cwd, "observations.txt") }),
    remember(FACT),
  ]);
  assert.match(saved[1], /Remembered: learning in azurite/);
  const id = opened.session.sessionManager.getSessionId();
  const file = opened.session.sessionManager.getSessionFile()!;
  const user = opened.session.sessionManager
    .getEntries()
    .find((e) => e.type === "message" && e.message.role === "user")!;
  if (scenario === "new-resume") {
    assert.equal((await opened.runtime.newSession()).cancelled, false);
    assert.notEqual(opened.session.sessionManager.getSessionId(), id);
    assert.match((await run([remember(OTHER)]))[0], /Write blocked at GATE/);
    assert.equal((await opened.runtime.switchSession(file)).cancelled, false);
    assert.equal(opened.session.sessionManager.getSessionId(), id);
  } else if (scenario === "fork") {
    assert.equal((await opened.runtime.fork(user.id)).cancelled, false);
    assert.notEqual(opened.session.sessionManager.getSessionId(), id);
  } else if (scenario === "tree") {
    await opened.session.navigateTree(user.id);
    assert.equal(opened.session.sessionManager.getSessionId(), id);
  } else if (scenario === "reload") {
    await opened.session.reload();
    assert.equal(opened.session.sessionManager.getSessionId(), id);
  } else throw new Error(`Unknown scenario: ${scenario}`);
  assert.match((await run([remember(OTHER)]))[0], /Write blocked at GATE/);
  const recalled = await run([
    call("memory_recall", { query: "azurite deployment cobalt queue" }),
  ]);
  assert.ok(recalled[0].includes(FACT));
  const requests = await (await fetch(new URL("/__requests", baseUrl))).json();
  assert.ok(JSON.stringify(requests[0].messages).includes(FACT));
  console.log(`LIFECYCLE-PASS ${scenario}`);
} finally {
  await opened.runtime.dispose();
}
