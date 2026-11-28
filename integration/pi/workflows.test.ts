import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeGuest, REPO, startFake } from "../../e2e/support/harness.ts";

test("native extension commands run directly without model calls", async () => {
  const fake = await startFake();
  const guest = makeGuest(fake, REPO);
  const agentDir = join(guest.root, "pi");
  mkdirSync(agentDir);
  const config = join(guest.root, "memory-options.json");
  await Bun.write(
    config,
    JSON.stringify({
      autoCapture: false,
      captureOnCompact: false,
      injectBudget: 800,
    }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "workflows-runner.ts"),
      guest.projDir,
      agentDir,
      `http://127.0.0.1:${fake.port}/v1`,
      join(REPO, "src/adapters/pi/extension.ts"),
    ],
    {
      cwd: guest.projDir,
      env: {
        ...guest.env,
        USERPROFILE: guest.env.HOME,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CONFIG_DIR: join(guest.root, "pi-config"),
        PI_MEMORY_CONFIG: config,
        OPENAI_API_KEY: "fake-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, `${out}\n${err}`).toBe(0);
    expect(out).toContain("WORKFLOWS-PASS");
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    fake.stop();
    rmSync(guest.root, { recursive: true, force: true });
  }
}, 40_000);
