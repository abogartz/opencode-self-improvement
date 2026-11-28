import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import memory from "../../src/adapters/pi/extension.ts";
import { captureLagLines } from "../../src/status/metrics.ts";
import { summarizeHarnessActivity } from "../../src/status/harness-stats.ts";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, stepsFile, phase] = process.argv.slice(2);
const manifest = join(agentDir, "usage-session.json");
const saved = phase === "resume" ? await Bun.file(manifest).json() : undefined;
let updates = 0;
let settled = Promise.withResolvers<void>();
let cancel = false;
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const probe: ExtensionFactory = async (pi) => {
  await memory(pi);
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
const { session, runtime } = await openSession(cwd, agentDir, baseUrl, {
  extensions: [probe],
  persistent: true,
  sessionFile: saved?.file,
});
const stats = async () =>
  summarizeHarnessActivity(await captureLagLines(), []).harnesses.find(
    (g) => g.harness === "pi",
  )?.usage;
const report = async () => {
  await session.prompt("/memory-report");
  return JSON.stringify(session.messages.filter((m) => m.role === "custom"));
};
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
    assert.match(await report(), /pi: credited retrievals/);
  }
} finally {
  release.resolve();
  await runtime.dispose();
}
console.log(`USAGE-PASS ${phase}`);
