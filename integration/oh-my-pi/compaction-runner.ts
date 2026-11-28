import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import memory from "../../src/adapters/oh-my-pi/extension.ts";
import type { OmpAPI } from "../../src/adapters/oh-my-pi/context.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import { resolveRepo } from "../../src/identity/repokey.ts";
import { readEvidenceLog } from "../../test/helpers/logfmt.ts";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, stepsFile, scenario] = process.argv.slice(2);
const OWN =
  "The azurite release requires the cobalt manifest before deployment.";
const GLOBAL = "Keep the amber checklist available when reviewing a release.";
const FOREIGN = "The vermilion project uses the saffron staging queue.";
const HEADER = "## Durable memory to preserve in this summary";
const trace: string[] = [];
const prepared = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let holdPreparation = scenario === "aborted";
const probe: ExtensionFactory = async (pi) => {
  const host: OmpAPI = pi;
  await memory({
    registerTool: (tool) => pi.registerTool(tool),
    on(name, handler) {
      host.on(name, async (event, ctx) => {
        const result = await handler(event, ctx);
        trace.push(name);
        if (name === "session.compacting") {
          assert.equal(
            readEvidenceLog().filter((row) => row.ev === "t2_compaction")
              .length,
            0,
          );
          if (holdPreparation) {
            prepared.resolve();
            await release.promise;
          }
        }
        return result;
      });
    },
  });
};
const other: ExtensionFactory = (pi) => {
  if (scenario === "override")
    pi.on("session_before_compact", async (event) => ({
      compaction: {
        summary: "CUSTOM-SUMMARY",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    }));
  if (scenario === "later-hook")
    pi.on("session.compacting", async () => ({
      context: ["OTHER-CONTEXT"],
      prompt: "CUSTOM-COMPACTION-PROMPT",
      preserveData: { otherExtension: true },
    }));
};
const { session } = await openSession(cwd, agentDir, baseUrl, {
  extensions: [probe, other],
});
try {
  await Bun.write(
    stepsFile,
    JSON.stringify({
      "COMPACT::turn": [
        {
          content:
            "The setup is complete. Continue with the next task when ready.",
        },
      ],
    }),
  );
  await session.prompt(
    "COMPACT::turn acknowledge this test setup and wait for the next task.",
  );
  if (scenario !== "empty") {
    const foreignDir = join(agentDir, "foreign");
    mkdirSync(foreignDir);
    for (const [content, repo, status] of [
      [OWN, resolveRepo(cwd).key, "settled"],
      [GLOBAL, "global", "open"],
      [FOREIGN, resolveRepo(foreignDir).key, "settled"],
    ] as const)
      await appendMemory({
        type: "context",
        scope: "release",
        content,
        repo,
        status,
      });
  }
  // These facts were added after the prompt: only the compaction hook can supply them.
  assert.ok(!JSON.stringify(session.messages).includes(OWN));
  await fetch(new URL("/__reset", baseUrl), { method: "POST" });
  if (scenario === "aborted") {
    const before = JSON.stringify(session.messages);
    const rejected = assert.rejects(
      session.compact("CANCELLED-FOCUS"),
      /cancel/i,
    );
    await prepared.promise;
    session.abortCompaction();
    holdPreparation = false;
    release.resolve();
    await rejected;
    assert.equal(JSON.stringify(session.messages), before);
    assert.ok(!trace.includes("session_compact"));
    assert.equal(
      readEvidenceLog().filter((row) => row.ev === "t2_compaction").length,
      0,
    );
    assert.deepEqual(
      await (await fetch(new URL("/__requests", baseUrl))).json(),
      [],
    );
  }
  const compacted = await session.compact(
    "CALLER-FOCUS: keep the outstanding operator request.",
  );
  const requests = (await (
    await fetch(new URL("/__requests", baseUrl))
  ).json()) as { messages: unknown[] }[];
  const sent = JSON.stringify(requests);
  const t2 = readEvidenceLog().filter((row) => row.ev === "t2_compaction");
  assert.equal(
    t2.length,
    1,
    "completed compaction must finalize bookkeeping exactly once",
  );
  assert.ok(trace.includes("session_compact"));
  if (scenario === "override") {
    assert.equal(compacted.summary, "CUSTOM-SUMMARY");
    assert.equal(requests.length, 0);
    assert.ok(!trace.includes("session.compacting"));
  } else {
    // The pinned host makes history, split-turn and short summaries for this fixture.
    // Empty stores and supplied anchors must use the same three requests.
    assert.equal(requests.length, 3);
    assert.ok(trace.includes("session.compacting"));
    assert.ok(sent.includes("CALLER-FOCUS"));
    assert.ok(!sent.includes(FOREIGN));
    assert.ok(!sent.includes("You mine one coding-agent session transcript"));
    if (scenario === "anchors" || scenario === "aborted") {
      assert.ok(
        sent.includes(HEADER),
        "the summarizer request must receive the durable-memory anchor",
      );
      assert.ok(sent.includes(OWN));
      assert.ok(sent.includes(GLOBAL));
    } else {
      assert.ok(!sent.includes(HEADER));
      assert.ok(!sent.includes(OWN));
      if (scenario === "later-hook") {
        assert.ok(sent.includes("OTHER-CONTEXT"));
        assert.ok(sent.includes("CUSTOM-COMPACTION-PROMPT"));
        assert.equal(compacted.preserveData?.otherExtension, true);
      }
    }
  }
  console.log(`COMPACTION-PASS ${scenario}`);
} finally {
  release.resolve();
  await session.dispose();
}
