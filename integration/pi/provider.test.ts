import { expect, test } from "bun:test";
import { mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeGuest, REPO, startFake } from "../../e2e/support/harness.ts";

for (const scenario of [
  "success",
  "error",
  "throw",
  "continuation",
  "aborted",
  "two-turns",
  "long-session",
  "long-session-delta",
])
  test(`host-registered provider completion: ${scenario}`, async () => {
    const fake = await startFake();
    const guest = makeGuest(fake, REPO);
    const agentDir = join(guest.root, "pi");
    mkdirSync(agentDir);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "provider-runner.ts"),
        guest.projDir,
        agentDir,
        `http://127.0.0.1:${fake.port}/v1`,
        join(fake.dir, "steps.json"),
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
          PI_MEMORY_CONFIG: join(guest.root, "memory-options.json"),
          OPENAI_API_KEY: "fake-key",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    // Include cold SDK startup, the agent turn and shutdown, not just capture.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 90_000);
    try {
      const [exit, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(
        exit,
        `${timedOut ? "Provider process exceeded 90s\n" : ""}${out}\n${err}`,
      ).toBe(0);
      expect(out).toContain(`PROVIDER-PASS ${scenario}`);
      if (scenario === "error" || scenario === "throw") {
        const dir = join(guest.memoryDir, "evidence");
        const evidence = readdirSync(dir)
          .map((file) => readFileSync(join(dir, file), "utf8"))
          .join("\n");
        for (const output of [err, evidence]) {
          expect(output).toMatch(
            /Capture completion failed \((provider_error|request_failed)\)/,
          );
          expect(output).not.toContain(
            "opaqueFixtureCredential7f35a19cd2b64801",
          );
          expect(output).not.toContain("Capture provider rejected");
          expect(output).not.toContain("Provider transport rejected");
        }
        expect(out).not.toContain("opaqueFixtureCredential7f35a19cd2b64801");
      }
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
      fake.stop();
      rmSync(guest.root, { recursive: true, force: true });
    }
  }, 100_000);
