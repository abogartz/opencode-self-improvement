import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendMemory } from "../../src/store/files/append.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { resolveRepo } from "../../src/identity/repokey.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";
import { withTempStore } from "../helpers/temp-store.ts";
import { runScenario } from "./scenario.ts";

const store = withTempStore({ prefix: "osi-compact-simulator-" });
const OWN =
  "When azurite deployment reports a stale manifest: rebuild the project manifest using the cobalt queue before retrying the release.";
const OTHER =
  "When vermilion tooling reports an expired cache: refresh the shared cache using the saffron command before repeating the operation.";
const GLOBAL = "Keep the amber checklist available when reviewing a release.";
const QUERY =
  "azurite deployment stale manifest and vermilion tooling expired cache";
const rollups = () =>
  readEvidenceLog().filter((row) => row.ev === "t2_compaction");
function project(name: string) {
  const dir = join(store.root, name);
  mkdirSync(dir);
  return dir;
}

test("anchor-only preparation defers capture and exposes admitted work without blocking completion", async () => {
  await runScenario("deferred compaction capture", async (s) => {
    const h = s.host("host", {
      directory: project("a"),
      options: { autoCapture: true },
    });
    await h.start();
    await h.ground("reader");
    const transcript = [
      {
        role: "user" as const,
        text: `${OWN} ${GLOBAL} These verified procedures should remain available after summarization.`,
      },
    ];
    await h.emit("compact", {
      sessionID: "reader",
      phase: "prepare",
      transcript,
      capture: false,
      captureStarted: () => {
        throw new Error("anchor preparation started capture");
      },
    });
    expect(h.generation.calls).toHaveLength(0);
    const model = h.generation.pause("compaction model");
    let captured: Promise<void> | undefined;
    await h.emit("compact", {
      sessionID: "reader",
      phase: "prepare",
      transcript,
      captureStarted: (work) => {
        captured = work;
      },
    });
    expect(captured).toBeDefined();
    await model.entered;
    await h.emit("compact", {
      sessionID: "reader",
      phase: "complete",
      transcript: undefined,
    });
    expect(rollups()).toHaveLength(1);
    model.resolve(
      JSON.stringify([
        { type: "learning", scope: "release", content: OWN, status: "settled" },
      ]),
    );
    await captured;
    expect((await loadAll()).map((row) => row.content)).toEqual([OWN]);
    expect(h.generation.calls).toHaveLength(1);
    expect(readEvidenceLog().some((row) => row.ev === "hook_error")).toBe(
      false,
    );
  });
});

test("the programmable compaction operation supplies scoped anchors before finalizing once", async () => {
  const a = project("a");
  const b = project("b");
  await runScenario("split compaction phases", async (s) => {
    const h = s.host("host", { directory: a });
    await h.start();
    await h.move("reader", a);
    for (const [content, repo, status] of [
      [OWN, resolveRepo(a).key, "settled"],
      [OTHER, resolveRepo(b).key, "settled"],
      [GLOBAL, "global", "open"],
    ] as const) {
      await appendMemory({
        type: "context",
        scope: "release",
        content,
        repo,
        status,
      });
    }
    const system = ["Host summary instructions"];
    await h.emit("compact", {
      sessionID: "reader",
      phase: "prepare",
      transcript: undefined,
      appendSystem: (text) => system.push(text),
    });
    expect(system[0]).toBe("Host summary instructions");
    expect(system[1]).toInclude(OWN);
    expect(system[1]).toInclude(GLOBAL);
    expect(system[1]).not.toInclude(OTHER);
    expect(rollups()).toHaveLength(0);
    await h.emit("compact", {
      sessionID: "reader",
      phase: "complete",
      transcript: undefined,
      appendSystem: () => {
        throw new Error("completion has no summarizer");
      },
    });
    expect(rollups()).toHaveLength(1);
    expect(h.generation.calls).toHaveLength(0);
    expect(readEvidenceLog().some((row) => row.ev === "hook_error")).toBe(
      false,
    );
    expect(s.trace.entries.some((e) => e.event === "compact.end")).toBe(true);
  });
});

test("an abandoned preparation does not invalidate frozen context; completion does", async () => {
  await runScenario("abandoned preparation", async (s) => {
    const h = s.host("host", { directory: project("a") });
    await h.start();
    await h.ground("writer");
    const remember = (content: string, scope: string) =>
      h.invoke("writer", "memory_remember", {
        type: "learning",
        scope,
        content,
        status: "settled",
      });
    expect((await remember(OWN, "azurite")).content).toStartWith("Remembered:");
    expect(await h.request("writer", QUERY)).toInclude(OWN);
    expect((await remember(OTHER, "vermilion")).content).toStartWith(
      "Remembered:",
    );
    expect(await h.request("writer", QUERY)).not.toInclude(OTHER);
    const system: string[] = [];
    await h.emit("compact", {
      sessionID: "writer",
      phase: "prepare",
      transcript: undefined,
      appendSystem: (text) => system.push(text),
    });
    expect(system.join("\n")).toInclude(OTHER);
    expect(rollups()).toHaveLength(0);
    expect(await h.request("writer", QUERY)).not.toInclude(OTHER);
    await h.emit("compact", {
      sessionID: "writer",
      phase: "complete",
      transcript: undefined,
    });
    expect(await h.request("writer", QUERY)).toInclude(OTHER);
    expect(rollups()).toHaveLength(1);
  });
});

test("a rejected anchor callback is contained and completion remains usable", async () => {
  await runScenario("rejected summary context", async (s) => {
    const h = s.host("host", { directory: project("a") });
    await h.start();
    await appendMemory({
      type: "learning",
      scope: "azurite",
      content: OWN,
      repo: "global",
    });
    await h.emit("compact", {
      sessionID: "reader",
      phase: "prepare",
      transcript: undefined,
      appendSystem: () => {
        throw new Error("host refused context");
      },
    });
    expect(rollups()).toHaveLength(0);
    expect(readEvidenceLog().some((row) => row.ev === "hook_error")).toBe(true);
    await h.emit("compact", {
      sessionID: "reader",
      phase: "complete",
      transcript: undefined,
    });
    expect(rollups()).toHaveLength(1);
    expect(await h.request("reader", QUERY)).toInclude(OWN);
  });
});

test("a host with one compaction notification retains the combined contract", async () => {
  await runScenario("single compaction hook", async (s) => {
    const h = s.host("host", { directory: project("a") });
    await h.start();
    await appendMemory({
      type: "learning",
      scope: "azurite",
      content: OWN,
      repo: "global",
    });
    const system: string[] = [];
    await h.emit("compact", {
      sessionID: "reader",
      transcript: undefined,
      appendSystem: (text) => system.push(text),
    });
    expect(system.join("\n")).toInclude(OWN);
    expect(rollups()).toHaveLength(1);
  });
});
