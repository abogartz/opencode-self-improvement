import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

async function main() {
  let binary = process.argv[2] || Bun.which("opencode");
  if (!binary)
    throw new Error("Usage: bun repro.ts [path-to-opencode-executable]");
  binary = resolve(binary);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
    const target = readFileSync(binary, "utf8").match(
      /"%(?:~?dp0)%\\([^"]+\.exe)"/i,
    )?.[1];
    assert(
      target,
      "Pass the actual opencode.exe path instead of its shell wrapper",
    );
    binary = join(dirname(binary), target);
  }
  const executable = binary;
  const version = Bun.spawnSync([executable, "--version"]);
  assert.equal(version.exitCode, 0, version.stderr.toString());
  console.log(`${version.stdout.toString().trim()}; Bun ${Bun.version}`);
  console.log(`${process.platform} ${release()} ${arch()}`);

  const root = mkdtempSync(join(tmpdir(), "opencode-cleanup-repro-"));
  console.log(`Receipts and process logs: ${root}`);
  const plugin = join(root, "plugin");
  mkdirSync(plugin);
  copyFileSync(join(import.meta.dir, "plugin.ts"), join(plugin, "index.ts"));
  writeFileSync(
    join(plugin, "package.json"),
    JSON.stringify({
      name: "cleanup-probe",
      version: "0.0.0",
      type: "module",
      main: "index.ts",
    }),
  );

  // Every request gets the same answer; no model service or credentials are needed.
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/chat/completions")
      )
        return new Response("Not found", { status: 404 });
      const { stream } = await request.json();
      const base = { id: "chatcmpl-probe", created: 0, model: "scripted" };
      const message = { role: "assistant", content: "done" };
      if (!stream)
        return Response.json({
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason: "stop" }],
        });
      const chunks = [
        {
          ...base,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: message, finish_reason: null }],
        },
        {
          ...base,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });

  function guest(name: string) {
    const cwd = join(root, name);
    mkdirSync(cwd);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
      OPENCODE_PASSWORD: crypto.randomUUID(),
      CLEANUP_PROBE_OUT: join(cwd, "receipts.txt"),
    };
    for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
      if (process.env[key]) env[key] = process.env[key];
    for (const key of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "TEMP",
      "TMP",
    ]) {
      env[key] = join(cwd, key);
      mkdirSync(env[key]);
    }
    writeFileSync(
      join(cwd, "opencode.json"),
      JSON.stringify({
        autoupdate: false,
        snapshot: false,
        plugins: [{ package: plugin }],
        model: "fake/scripted",
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: `http://127.0.0.1:${fake.port}/v1`,
              apiKey: "unused",
            },
            models: { scripted: { name: "Scripted" } },
          },
        },
      }),
    );
    return { cwd, env };
  }

  function start(
    args: string[],
    context: ReturnType<typeof guest>,
    onLine?: (line: string) => void,
  ) {
    const child = Bun.spawn([executable, ...args], {
      ...context,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      child.kill(9);
    }, 30_000);
    const stderr = new Response(child.stderr).text();
    const stdout = (async () => {
      let text = "";
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        const part = decoder.decode(chunk, { stream: true });
        text += part;
        pending += part;
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n");
          onLine?.(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
      }
      return text;
    })();
    const done = Promise.all([child.exited, stdout, stderr])
      .then(([code, out, err]) => {
        writeFileSync(join(context.cwd, `${args[0]}.stdout.txt`), out);
        writeFileSync(join(context.cwd, `${args[0]}.stderr.txt`), err);
        return { code, out, err, forced };
      })
      .finally(() => clearTimeout(timer));
    return { child, done };
  }

  async function turn(context: ReturnType<typeof guest>, server?: string) {
    const run = start(
      [
        "run",
        ...(server ? ["--server", server] : ["--standalone"]),
        "--format",
        "json",
        "-m",
        "fake/scripted",
        "Reply with done.",
      ],
      context,
    );
    await run.child.stdin.end();
    const result = await run.done;
    assert(!result.forced, "Turn timed out; this is not a reproduction");
    assert.equal(result.code, 0, result.err);
    const events = result.out
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line));
    assert(!events.some((event) => event.type === "error"), result.out);
    assert(
      events.some(
        (event) => event.type === "text" && event.part?.text === "done",
      ),
      result.out,
    );
    console.log(
      `${server ? "cooperative" : "standalone"}: CLI exit=0, answer=done`,
    );
  }

  try {
    const standalone = guest("standalone");
    await turn(standalone);

    const cooperative = guest("cooperative");
    const ready = Promise.withResolvers<string>();
    const server = start(
      ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
      cooperative,
      (line) => {
        try {
          const value = JSON.parse(line);
          if (typeof value.url === "string") ready.resolve(value.url);
        } catch {
          /* Diagnostics may precede the readiness JSON. */
        }
      },
    );
    try {
      const url = await Promise.race([
        ready.promise,
        server.done.then((result) => {
          throw new Error(`Server exited before readiness: ${result.err}`);
        }),
      ]);
      await turn(cooperative, url);
    } finally {
      // EOF releases the server's ownership lease; it is not a forced kill.
      await server.child.stdin.end();
      const result = await server.done;
      assert(!result.forced, "Control timed out; this is not a reproduction");
      assert.equal(result.code, 0, result.err);
    }

    const receipts = (context: ReturnType<typeof guest>) =>
      readFileSync(context.env.CLEANUP_PROBE_OUT, "utf8").trim().split("\n");
    const observed = receipts(standalone);
    const control = receipts(cooperative);
    console.log(`standalone receipts: ${observed.join(", ")}`);
    console.log(`cooperative receipts: ${control.join(", ")}`);
    assert(observed.includes("setup"), "Standalone did not load the probe");
    assert(
      control.includes("setup") &&
        control.includes("cleanup-start") &&
        control.includes("cleanup-end"),
      "Cooperative cleanup did not complete; this is not a reproduction",
    );
    const missing =
      !observed.includes("cleanup-start") || !observed.includes("cleanup-end");
    console.log(
      missing
        ? "REPRODUCED: standalone exited without completing plugin cleanup."
        : "NOT REPRODUCED: both shutdown paths completed plugin cleanup.",
    );
    process.exitCode = missing ? 1 : 0;
  } finally {
    fake.stop(true);
  }
}

main().catch((error) => {
  console.error("INCONCLUSIVE:", error);
  process.exitCode = 2;
});
