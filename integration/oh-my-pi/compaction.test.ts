import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  makeGuest,
  REPO,
  startFake,
  type Fake,
  type Guest,
} from "../../e2e/support/harness.ts";

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

for (const scenario of [
  "anchors",
  "empty",
  "override",
  "later-hook",
  "aborted",
]) {
  test(`real oh-my-pi compaction: ${scenario}`, async () => {
    const g = makeGuest(fake, REPO);
    guests.push(g);
    const agentDir = join(g.root, "omp");
    mkdirSync(agentDir);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "compaction-runner.ts"),
        g.projDir,
        agentDir,
        `http://127.0.0.1:${fake.port}/v1`,
        join(fake.dir, "steps.json"),
        scenario,
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
      expect(exit, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toInclude(`COMPACTION-PASS ${scenario}`);
      expect(stderr).not.toInclude("extension runtime error");
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
    }
  }, 100_000);
}
