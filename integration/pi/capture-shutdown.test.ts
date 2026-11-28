import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeGuest, REPO, startFake } from "../../e2e/support/harness.ts";

for (const scenario of ["answered", "unanswered"]) {
  test(`default capture respects real SDK shutdown: ${scenario}`, async () => {
    const fake = await startFake();
    const guest = makeGuest(fake, REPO);
    const agentDir = join(guest.root, "pi");
    mkdirSync(agentDir);
    fake.setSteps({
      "SHUTDOWN::turn": [
        {
          tool_calls: [
            {
              id: "read-archive",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({
                  path: join(guest.projDir, "archive.txt"),
                }),
              },
            },
          ],
        },
        { content: "Verified the archive policy." },
        {
          content: JSON.stringify([
            {
              type: "context",
              scope: "batch",
              content:
                "The nightly archive job keeps fourteen days of tarballs.",
              status: "settled",
            },
          ]),
        },
      ],
    });
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "capture-shutdown-runner.ts"),
        guest.projDir,
        agentDir,
        `http://127.0.0.1:${fake.port}/v1`,
        join(REPO, "src/adapters/pi/extension.ts"),
        scenario,
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
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toInclude(`CAPTURE-SHUTDOWN-PASS ${scenario}`);
      expect(stderr).not.toInclude("timed out");
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
      fake.stop();
      rmSync(guest.root, { recursive: true, force: true });
    }
  }, 40_000);
}
