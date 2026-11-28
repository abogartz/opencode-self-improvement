import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeGuest, REPO, startFake } from "../../e2e/support/harness.ts";

for (const scenario of [
  "tree",
  "branch",
  "switch",
  "compact",
  "compact-override",
  "compact-cancelled",
  "compact-disabled",
  "compact-shutdown-answered",
  "compact-shutdown-unanswered",
]) {
  test(`capture follows actual SDK boundaries: ${scenario}`, async () => {
    const fake = await startFake();
    const guest = makeGuest(fake, REPO);
    const agentDir = join(guest.root, "omp");
    mkdirSync(agentDir);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "capture-boundaries-runner.ts"),
        guest.projDir,
        agentDir,
        `http://127.0.0.1:${fake.port}/v1`,
        join(fake.dir, "steps.json"),
        scenario,
      ],
      {
        cwd: guest.projDir,
        env: {
          ...guest.env,
          USERPROFILE: guest.env.HOME,
          PI_CODING_AGENT_DIR: agentDir,
          PI_CONFIG_DIR: join(guest.root, "omp-config"),
          OPENAI_API_KEY: "fake-key",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill(), 45_000);
    try {
      const [exit, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit, `${out}\n${err}`).toBe(0);
      expect(out).toContain(`BOUNDARY-PASS ${scenario}`);
      expect(err).not.toContain("extension runtime error");
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
      fake.stop();
      rmSync(guest.root, { recursive: true, force: true });
    }
  }, 50_000);
}
