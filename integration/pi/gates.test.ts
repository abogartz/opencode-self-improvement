import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeGuest, REPO, startFake } from "../../e2e/support/harness.ts";

for (const shell of ["bash", "powershell"])
  test(`real Pi ${shell} errors preserve failed-to-passed gate evidence`, async () => {
    const fake = await startFake();
    const guest = makeGuest(fake, REPO);
    const agentDir = join(guest.root, "pi");
    mkdirSync(agentDir);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "gates-runner.ts"),
        guest.projDir,
        agentDir,
        `http://127.0.0.1:${fake.port}/v1`,
        join(fake.dir, "steps.json"),
        shell,
      ],
      {
        cwd: guest.projDir,
        env: {
          ...guest.env,
          USERPROFILE: guest.env.HOME,
          PI_CODING_AGENT_DIR: agentDir,
          PI_CONFIG_DIR: join(guest.root, "pi-config"),
          OPENAI_API_KEY: "fake-key",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill(), 60_000);
    try {
      const [exit, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit, `${out}\n${err}`).toBe(0);
      expect(out).toContain("GATES-PASS");
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
      fake.stop();
      rmSync(guest.root, { recursive: true, force: true });
    }
  }, 70_000);
