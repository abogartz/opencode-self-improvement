import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import memory from "../../src/adapters/oh-my-pi/extension.ts";
import type {
  OmpAPI,
  OmpContext,
  OmpTool,
} from "../../src/adapters/oh-my-pi/context.ts";
import { captureLagLines } from "../../src/status/metrics.ts";
import { summarizeHarnessActivity } from "../../src/status/harness-stats.ts";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, stepsFile, phase] = process.argv.slice(2);
const manifest = join(agentDir, "usage-session.json");
const saved = phase === "resume" ? await Bun.file(manifest).json() : undefined;
let context: OmpContext;
let reportTool: OmpTool;
let updates = 0;
let settled = Promise.withResolvers<void>();
let cancel = false;
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const probe: ExtensionFactory = async (pi) => {
  const host: OmpAPI = pi;
  await memory({
    on: (name, handler) => host.on(name, handler),
    registerTool(tool) {
      if (tool.name === "memory_status") reportTool = tool;
      pi.registerTool(tool);
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
  });
  pi.on("message_update", async () => {
    updates++;
  });
  pi.on("agent_end", async () => {
    settled.resolve();
  });
  pi.on("before_agent_start", async () => {
    if (cancel) {
      entered.resolve();
      await release.promise;
    }
  });
};
const { session } = await openSession(cwd, agentDir, baseUrl, {
  extensions: [probe],
  persistent: true,
  sessionFile: saved?.file,
});
const stats = async () =>
  summarizeHarnessActivity(await captureLagLines(), []).harnesses.find(
    (g) => g.harness === "oh-my-pi",
  )?.usage;
const report = async () =>
  (await reportTool.execute("report", {}, undefined, undefined, context))
    .content[0]!.text;
try {
  if (phase === "write") {
    assert.equal(await stats(), null);
    for (let i = 0; i < 2; i++) {
      settled = Promise.withResolvers<void>();
      await Bun.write(
        stepsFile,
        JSON.stringify({ "USAGE::turn": [{ content: "USAGE-DONE" }] }),
      );
      await fetch(new URL("/__reset", baseUrl), { method: "POST" });
      await session.prompt("USAGE::turn finish this response");
      await settled.promise;
      assert.equal((await stats())?.input, 111 * (i + 1));
    }
    assert.ok(updates > 0);
    const before = await stats();
    assert.equal(before?.output, 44);
    assert.equal(before?.sessions, 1);
    cancel = true;
    const prompting = session.prompt("USAGE::turn cancel before sending");
    await entered.promise;
    const aborting = session.abort();
    release.resolve();
    await Promise.all([prompting, aborting]);
    assert.deepEqual(await stats(), before);
    await session.sessionManager.flush();
    await Bun.write(
      manifest,
      JSON.stringify({
        file: session.sessionManager.getSessionFile(),
        stats: before,
      }),
    );
  } else {
    assert.deepEqual(await stats(), saved.stats);
    assert.match(await report(), /input 222/);
    assert.match(await report(), /oh-my-pi: credited retrievals/);
  }
} finally {
  release.resolve();
  await session.dispose();
}
console.log(`USAGE-PASS ${phase}`);
