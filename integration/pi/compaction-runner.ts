import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createPiMemory } from "../../src/adapters/pi/extension.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { resolveRepo } from "../../src/identity/repokey.ts";
import { readEvidenceLog } from "../../test/helpers/logfmt.ts";
import { openSession } from "./session.ts";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

const [cwd, agentDir, baseUrl, stepsFile, scenario] = process.argv.slice(2);
const OWN =
  "The azurite release requires the cobalt manifest before deployment.";
const GLOBAL = "Keep the amber checklist available when reviewing a release.";
const FOREIGN = "The vermilion project uses the saffron staging queue.";
const FACT = "The nightly archive job keeps fourteen days of tarballs.";
const capturing = scenario.startsWith("capture");
let calls = 0;
const captureRequests: string[] = [];
const firstCapture = Promise.withResolvers<void>();
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.text();
    if (body.includes("You mine one coding-agent session transcript")) {
      captureRequests.push(body);
      const content =
        ++calls === 1
          ? "[]"
          : JSON.stringify([
              {
                type: "context",
                scope: "batch",
                content: FACT,
                status: "settled",
              },
            ]);
      firstCapture.resolve();
      return new Response(
        `data: ${JSON.stringify({ id: "capture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
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
const memory = createPiMemory({
  options: {
    autoCapture: capturing,
    captureOnCompact: scenario !== "capture-disabled",
  },
});
const other: ExtensionFactory = (pi) => {
  if (scenario === "cancel" || scenario === "capture-cancelled")
    pi.on("session_before_compact", async () => ({ cancel: true }));
  if (scenario === "override")
    pi.on("session_before_compact", async (event) => ({
      compaction: {
        summary: "CUSTOM-SUMMARY",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    }));
};
const { session, runtime } = await openSession(
  cwd,
  agentDir,
  `http://127.0.0.1:${proxy.port}/v1`,
  { extensions: [memory, other], retry: scenario === "retry" },
);
try {
  await Bun.write(join(cwd, "archive.txt"), FACT);
  await Bun.write(
    stepsFile,
    JSON.stringify({
      "COMPACT::turn": [
        {
          tool_calls: [
            {
              id: "read-archive",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: join(cwd, "archive.txt") }),
              },
            },
          ],
        },
        {
          content: "Verified the archive policy. The implementation is ready.",
        },
      ],
    }),
  );
  if (scenario === "repeated") {
    const steps = await Bun.file(stepsFile).json();
    steps["COMPACT::turn"].splice(1, 0, {
      tool_calls: [
        {
          id: "write-tracked",
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({
              path: join(cwd, "earlier-edited.ts"),
              content: "export const ready = true;",
            }),
          },
        },
      ],
    });
    await Bun.write(stepsFile, JSON.stringify(steps));
  }
  await session.prompt(
    `COMPACT::turn We finished the archive change. Remember that ${FACT} The batch importer respects the staging rate limit per key, which matters while wiring the importer tooling.`,
  );
  if (capturing) await firstCapture.promise;
  if (scenario !== "empty") {
    const foreign = join(agentDir, "foreign");
    mkdirSync(foreign);
    for (const [content, repo] of [
      [OWN, resolveRepo(cwd).key],
      [GLOBAL, "global"],
      [FOREIGN, resolveRepo(foreign).key],
    ])
      await appendMemory({
        type: "context",
        scope: "release",
        content,
        repo,
        status: "settled",
      });
  }
  assert.ok(!JSON.stringify(session.messages).includes(OWN));
  await fetch(new URL("/__reset", baseUrl), { method: "POST" });
  let summaryAttempts = 0;
  if (scenario === "retry" || scenario === "routing") {
    const originalStream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => {
      summaryAttempts++;
      assert.ok(
        JSON.stringify(context).includes(OWN),
        "every summary attempt retains memory anchors",
      );
      assert.equal(model.id, "scripted");
      assert.equal(
        options?.apiKey,
        "fake-key",
        "native summary auth reaches a custom agent stream",
      );
      if (scenario === "retry" && summaryAttempts === 1) {
        const stream = createAssistantMessageEventStream();
        const error: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: "error",
          errorMessage: "terminated",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        stream.push({ type: "error", reason: "error", error });
        stream.end(error);
        return stream;
      }
      return originalStream(model, context, options);
    };
  }
  if (scenario === "cancel" || scenario === "capture-cancelled") {
    const before = JSON.stringify(session.messages);
    await assert.rejects(session.compact("CALLER-FOCUS"), /cancel/i);
    assert.equal(JSON.stringify(session.messages), before);
    assert.equal(
      readEvidenceLog().filter((row) => row.ev === "t2_compaction").length,
      0,
    );
  } else {
    const result = await session.compact(
      "CALLER-FOCUS: keep the outstanding operator request.",
    );
    assert.equal(
      readEvidenceLog().filter((row) => row.ev === "t2_compaction").length,
      1,
    );
    if (scenario === "override") assert.equal(result.summary, "CUSTOM-SUMMARY");
    const sent = JSON.stringify(
      await (await fetch(new URL("/__requests", baseUrl))).json(),
    );
    if (scenario !== "override") assert.ok(sent.includes("CALLER-FOCUS"));
    assert.ok(!sent.includes(FOREIGN));
    assert.equal(
      sent.includes(OWN),
      scenario !== "empty" && scenario !== "override",
    );
    assert.equal(
      sent.includes(GLOBAL),
      scenario !== "empty" && scenario !== "override",
    );
    if (scenario === "retry") assert.equal(summaryAttempts, 2);
    if (scenario === "routing") assert.equal(summaryAttempts, 1);
    if (scenario === "repeated") {
      const previous = session.sessionManager
        .getBranch()
        .findLast((e) => e.type === "compaction");
      assert.ok(previous?.type === "compaction");
      assert.equal(
        previous.fromHook,
        false,
        "native summarization must retain native tracking",
      );
      // Exercise restoration from summaries produced by the older adapter too.
      previous.fromHook = true;
      const priorDetails = previous.details as {
        readFiles: string[];
        modifiedFiles: string[];
      };
      assert.ok(
        priorDetails.readFiles.some((file) => file.endsWith("archive.txt")),
      );
      assert.ok(
        priorDetails.modifiedFiles.some((file) =>
          file.endsWith("earlier-edited.ts"),
        ),
      );
      await Bun.write(
        stepsFile,
        JSON.stringify({
          "COMPACT::second": [
            { content: "The follow-up discussion is complete." },
          ],
        }),
      );
      await session.prompt(
        "COMPACT::second Discuss the deployment checklist without reading any files.",
      );
      const second = await session.compact(
        "Keep the outstanding operator request.",
      );
      const details = second.details as {
        readFiles: string[];
        modifiedFiles: string[];
      };
      assert.ok(details.readFiles.some((file) => file.endsWith("archive.txt")));
      assert.ok(
        details.modifiedFiles.some((file) =>
          file.endsWith("earlier-edited.ts"),
        ),
      );
    }
  }
  await runtime.dispose();
  if (capturing) {
    const expected = scenario === "capture";
    assert.equal(calls, expected ? 2 : 1);
    assert.equal(
      (await loadAll()).some((row) => row.content === FACT),
      expected,
    );
    if (expected) {
      assert.ok(captureRequests[1].includes(FACT));
      assert.ok(!captureRequests[1].includes("CUSTOM-SUMMARY"));
      const request = JSON.parse(captureRequests[1]);
      const prompt = request.messages
        .map((m: { content: unknown }) =>
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        )
        .join("\n");
      const transcript = prompt
        .split(/(?:Session work[^\n]*|Transcript):\n/)
        .at(-1)!;
      assert.notEqual(
        transcript,
        prompt,
        "capture must identify the original evidence section",
      );
      assert.ok(
        !transcript.includes(OWN),
        "anchors may occur in known memories, never the source transcript",
      );
    }
  }
  console.log(`COMPACTION-PASS ${scenario}`);
} finally {
  await runtime.dispose();
  proxy.stop(true);
}
