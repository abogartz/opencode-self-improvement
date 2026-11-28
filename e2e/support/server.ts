import type { Guest } from "./harness.ts";
import { resolveOpencode } from "./harness.ts";

/** Own a real server through its stdin lease, so shutdown can run plugin cleanup. */
export async function startServer(guest: Guest) {
  guest.env.OPENCODE_PASSWORD = crypto.randomUUID();
  const child = Bun.spawn(
    [
      resolveOpencode(),
      "serve",
      "--stdio",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      cwd: guest.projDir,
      env: guest.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const ready = Promise.withResolvers<string>();
  const stderr = new Response(child.stderr).text();
  const output = (async () => {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (typeof value.url === "string") ready.resolve(value.url);
        } catch {
          /* Server diagnostics can precede readiness. */
        }
      }
    }
    ready.reject(new Error(`server exited before readiness: ${await stderr}`));
  })();
  const timer = setTimeout(() => {
    ready.reject(new Error("server readiness timed out"));
    child.kill(9);
  }, 15_000);
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= (async () => {
      let forced = false;
      const kill = setTimeout(() => {
        forced = true;
        child.kill(9);
      }, 10_000);
      try {
        await child.stdin.end();
        const code = await child.exited;
        await output;
        if (forced || code !== 0)
          throw new Error(
            `server shutdown failed (forced=${forced}, exit=${code}): ${await stderr}`,
          );
      } catch (error) {
        child.kill(9);
        await child.exited;
        await output;
        throw error;
      } finally {
        clearTimeout(kill);
      }
    })();
    return stopping;
  }
  try {
    return { url: await ready.promise, stop };
  } catch (error) {
    child.kill(9);
    await child.exited;
    await output;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
