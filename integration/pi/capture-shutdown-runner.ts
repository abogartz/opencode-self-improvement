import assert from "node:assert/strict";
import { join } from "node:path";
import { openSession } from "./session.ts";
import { loadAll } from "../../src/store/files/load.ts";

const [cwd, agentDir, baseUrl, extensionPath, scenario] = process.argv.slice(2);
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.text();
    if (body.includes("You mine one coding-agent session transcript")) {
      entered.resolve();
      if (scenario === "unanswered") await release.promise;
      else await Bun.sleep(100);
    }
    return fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  },
});
const fact = "The nightly archive job keeps fourteen days of tarballs.";
await Bun.write(join(cwd, "archive.txt"), fact);
const { session, runtime } = await openSession(
  cwd,
  agentDir,
  `http://127.0.0.1:${proxy.port}/v1`,
  { extensionPath },
);
try {
  await session.prompt(
    `SHUTDOWN::turn We finished the archive change. Remember that ${fact} The batch importer respects the staging rate limit per key, which matters while wiring the importer tooling.`,
  );
  await entered.promise;
  const started = performance.now();
  await runtime.dispose();
  const duration = performance.now() - started;
  assert.ok(duration < 1900, `shutdown exceeded its own budget: ${duration}ms`);
  release.resolve();
  await Bun.sleep(150);
  const rows = await loadAll();
  assert.deepEqual(
    rows.map((row) => row.content),
    scenario === "unanswered" ? [] : [fact],
  );
  if (rows.length) assert.ok(rows[0].tags?.includes("auto-capture"));
  console.log(`CAPTURE-SHUTDOWN-PASS ${scenario}`);
} finally {
  release.resolve();
  await runtime.dispose();
  proxy.stop(true);
}
