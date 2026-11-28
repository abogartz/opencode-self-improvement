import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createPiMemory } from "../../src/adapters/pi/extension.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import { resolveRepo } from "../../src/identity/repokey.ts";
import { readLines } from "../../src/core/logfmt/read.ts";
import { parseLine } from "../../src/core/logfmt/format.ts";
import { hitsFile } from "../../src/telemetry/ledger.ts";
import { PULL_HEADER } from "../../src/inject/pull.ts";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, stepsFile, scenario] = process.argv.slice(2);
const FACT =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
const file = join(cwd, "observations.txt");
await Bun.write(file, "azurite deployment stale manifest cobalt queue");
await appendMemory({
  type: "learning",
  scope: "azurite",
  content: FACT,
  repo: resolveRepo(cwd).key,
});
let placed = false;
const formatter: ExtensionFactory = (pi) => {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "read") return;
    placed = JSON.stringify(event.content).includes(FACT);
    if (scenario === "clipped") {
      assert.ok(
        placed,
        "the formatter must see a placed memory before removing it",
      );
      return {
        content: event.content.map((part) =>
          part.type === "text"
            ? {
                ...part,
                text: part.text
                  .split("\n")
                  .filter((line) => !line.includes(FACT))
                  .join("\n"),
              }
            : part,
        ),
      };
    }
  });
};
const memory: ExtensionFactory = createPiMemory({
  options:
    scenario === "disabled"
      ? { pullTools: [] }
      : scenario === "arguments-only"
        ? { pullOutputChars: 0 }
        : {},
});
const { session, runtime } = await openSession(cwd, agentDir, baseUrl, {
  extensions: [memory, formatter],
});
try {
  await Bun.write(
    stepsFile,
    JSON.stringify({
      "DELIVERY::turn": [
        {
          tool_calls: [
            {
              id: "read-delivery",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: file }),
              },
            },
          ],
        },
        { content: "DELIVERY-DONE" },
      ],
    }),
  );
  await fetch(new URL("/__reset", baseUrl), { method: "POST" });
  await session.prompt("DELIVERY::turn inspect the requested file");
  const requests = (await (
    await fetch(new URL("/__requests", baseUrl))
  ).json()) as { messages: { role: string; content: unknown }[] }[];
  const toolMessages = requests.flatMap((r) =>
    r.messages.filter((m) => m.role === "tool"),
  );
  assert.ok(toolMessages.length > 0);
  const delivered = JSON.stringify(toolMessages);
  const kept = scenario === "kept";
  assert.equal(placed, kept || scenario === "clipped");
  assert.equal(delivered.includes(FACT), kept);
  assert.equal(delivered.includes(PULL_HEADER), kept || scenario === "clipped");
  const credits = existsSync(hitsFile())
    ? (await readLines(hitsFile()))
        .map(parseLine)
        .filter((row) => row?.src === "pull")
    : [];
  assert.equal(credits.length, kept ? 1 : 0);
  assert.ok(JSON.stringify(session.messages).includes("DELIVERY-DONE"));
  console.log(`DELIVERY-PASS ${scenario}`);
} finally {
  await runtime.dispose();
}
