import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeGuest, REPO, startFake } from "../../e2e/support/harness.ts";

const fake = await startFake();
afterAll(() => fake.stop());
test("real oh-my-pi usage survives streaming, cancelled preparation and process restart without double counting", async () => {
  const g = makeGuest(fake, REPO);
  const agentDir = join(g.root, "omp");
  mkdirSync(agentDir);
  try {
    for (const phase of ["write", "resume"]) {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "usage-runner.ts"),
          g.projDir,
          agentDir,
          `http://127.0.0.1:${fake.port}/v1`,
          join(fake.dir, "steps.json"),
          phase,
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
        expect(stdout).toInclude(`USAGE-PASS ${phase}`);
      } finally {
        clearTimeout(timer);
        child.kill();
        await child.exited;
      }
    }
  } finally {
    rmSync(g.root, { recursive: true, force: true });
  }
}, 200_000);
