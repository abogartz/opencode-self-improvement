import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { createOhMyPiMemory } from "../../src/adapters/oh-my-pi/extension.ts";
import type { OmpAPI } from "../../src/adapters/oh-my-pi/context.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { readEvidenceLog } from "../../test/helpers/logfmt.ts";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, stepsFile, scenario] = process.argv.slice(2);
const compacting = scenario.startsWith("compact");
const fact = "The nightly archive job keeps fourteen days of tarballs.";
const other = "The release queue retains ninety days of staging manifests.";
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const compactCapture = Promise.withResolvers<void>();
let terminal = Promise.withResolvers<void>();
let captureCalls = 0;
let captureAnswer = compacting
  ? "[]"
  : JSON.stringify([
      { type: "context", scope: "batch", content: fact, status: "settled" },
    ]);
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.text();
    if (body.includes("You mine one coding-agent session transcript")) {
      captureCalls++;
      const answer = captureAnswer;
      entered.resolve();
      if (compacting && captureCalls === 2) {
        compactCapture.resolve();
        if (scenario === "compact-shutdown-unanswered") await release.promise;
        if (scenario === "compact-shutdown-answered") await Bun.sleep(100);
      }
      if (!compacting) await release.promise;
      return new Response(
        `data: ${JSON.stringify({ id: "capture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  },
});
const extension: ExtensionFactory = async (pi) => {
  const host: OmpAPI = pi;
  await createOhMyPiMemory({
    options: { captureOnCompact: scenario !== "compact-disabled" },
  })({
    registerTool: (tool) => pi.registerTool(tool),
    on(name, handler) {
      host.on(name, async (event, ctx) => {
        const result = await handler(event, ctx);
        if (name === "agent_end") terminal.resolve();
        return result;
      });
    },
  });
  if (scenario === "compact-cancelled")
    pi.on("session_before_compact", async () => ({ cancel: true }));
  if (scenario === "compact-override")
    pi.on("session_before_compact", async (event) => ({
      compaction: {
        summary: "CUSTOM",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    }));
};
const { session } = await openSession(
  cwd,
  agentDir,
  `http://127.0.0.1:${proxy.port}/v1`,
  { extensions: [extension], persistent: true },
);
const call = (name: string, args: unknown) => ({
  tool_calls: [
    {
      id: crypto.randomUUID(),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
try {
  await Bun.write(join(cwd, "archive.txt"), fact);
  await Bun.write(
    stepsFile,
    JSON.stringify({
      "BOUNDARY::turn": [
        call("read", { path: join(cwd, "archive.txt") }),
        { content: "Verified the archive policy." },
      ],
    }),
  );
  await session.prompt(
    `BOUNDARY::turn We finished the archive change. Remember that ${fact} The batch importer respects the staging rate limit per key, which matters while wiring the importer tooling.`,
  );
  await entered.promise;
  if (compacting) {
    await terminal.promise;
    assert.equal(captureCalls, 1);
    assert.equal((await loadAll()).length, 0);
    captureAnswer = JSON.stringify([
      { type: "context", scope: "batch", content: fact, status: "settled" },
    ]);
    if (scenario === "compact-cancelled")
      await assert.rejects(session.compact(), /cancel/i);
    else await session.compact();
    if (scenario.startsWith("compact-shutdown")) {
      await compactCapture.promise;
      const started = performance.now();
      await session.dispose();
      assert.ok(
        performance.now() - started < 1900,
        "shutdown exceeded its budget",
      );
      release.resolve();
      await Bun.sleep(150);
      assert.deepEqual(
        (await loadAll()).map((row) => row.content),
        scenario === "compact-shutdown-answered" ? [fact] : [],
      );
      assert.equal(captureCalls, 2);
    } else if (["compact", "compact-override"].includes(scenario)) {
      const deadline = Date.now() + 5000;
      while (!(await loadAll()).length && Date.now() < deadline)
        await Bun.sleep(10);
      assert.deepEqual(
        (await loadAll()).map((row) => row.content),
        [fact],
      );
      assert.equal(
        captureCalls,
        2,
        "one compaction capture, independent of turn-end cooldown",
      );
      assert.ok(readEvidenceLog().some((row) => row.trigger === "compaction"));
    } else {
      await session.dispose();
      assert.equal(captureCalls, 1);
      assert.equal((await loadAll()).length, 0);
    }
  } else {
    await session.sessionManager.flush();
    const user = session.sessionManager
      .getEntries()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
    assert.ok(user);
    const moving = (async () => {
      if (scenario === "tree")
        assert.equal(
          (await session.navigateTree(user.id, { summarize: false })).cancelled,
          false,
        );
      else if (scenario === "branch")
        assert.equal((await session.branch(user.id)).cancelled, false);
      else {
        const file = session.sessionFile;
        assert.ok(file);
        await session.newSession();
        assert.equal(
          await session.switchSession(file, { keepModel: true }),
          true,
        );
      }
    })();
    release.resolve();
    await moving;
    await terminal.promise;
    assert.deepEqual(
      (await loadAll()).map((row) => row.content),
      [fact],
      "old admitted capture retains its original grounding",
    );
    terminal = Promise.withResolvers<void>();
    captureAnswer = "[]";
    await fetch(new URL("/__reset", baseUrl), { method: "POST" });
    await Bun.write(
      stepsFile,
      JSON.stringify({
        "BOUNDARY::turn": [
          call("memory_remember", {
            type: "learning",
            scope: "release",
            content: other,
          }),
          { content: "finished" },
        ],
      }),
    );
    await session.prompt("BOUNDARY::turn Store the new release procedure.");
    await terminal.promise;
    assert.match(JSON.stringify(session.messages), /Write blocked at GATE/);
    assert.deepEqual(
      (await loadAll()).map((row) => row.content),
      [fact],
    );
  }
  console.log(`BOUNDARY-PASS ${scenario}`);
} finally {
  release.resolve();
  await session.dispose();
  proxy.stop(true);
}
