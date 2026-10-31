// Smoke test: the V2 plugin's setup registers the full surface (tools, tool &
// session hooks) and the memory-first prompt injection works. This is what
// "install from scratch as an opencode extension" depends on.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pluginDefault, { SelfImprovement } from "../index.ts";
import { memoryRoot } from "../src/config.ts";
import { formatLine } from "../src/logfmt.ts";
import { resetState } from "../src/state.ts";
import { loadPlugin } from "./harness.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-plugin-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(join(root, "repo"), { recursive: true });
  resetState();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const dir = () => join(process.env.OPENCODE_MEMORY_DIR!, "..", "repo");

describe("plugin wiring (OpenCode V2)", () => {
  test("default export is the plugin and setup registers tools + hooks", async () => {
    expect(pluginDefault).toBe(SelfImprovement);
    expect(pluginDefault.id).toBe("opencode-self-improvement");
    expect(typeof pluginDefault.setup).toBe("function");

    const loaded = await loadPlugin(dir());

    expect(Object.keys(loaded.tools).sort()).toEqual(
      [
        "memory_consolidate",
        "memory_decay",
        "memory_evidence",
        "memory_export",
        "memory_forget",
        "memory_import",
        "memory_init",
        "memory_list",
        "memory_merge_review",
        "memory_recall",
        "memory_remember",
        "memory_status",
        "memory_undo",
        "memory_update",
      ].sort(),
    );
    // tool hooks (execute.before/after) and session hooks (context/prompt/compaction)
    expect(typeof loaded.toolHooks["execute.before"]).toBe("function");
    expect(typeof loaded.toolHooks["execute.after"]).toBe("function");
    expect(typeof loaded.sessionHooks["context"]).toBe("function");
    expect(typeof loaded.sessionHooks["prompt"]).toBe("function");
    expect(typeof loaded.sessionHooks["compaction"]).toBe("function");
  });

  test("session.prompt leaves admitted text untouched; session.context delivers memory invisibly", async () => {
    const mem = join(memoryRoot(), "2026-09-18.logfmt");
    mkdirSync(memoryRoot(), { recursive: true });
    appendFileSync(
      mem,
      formatLine({
        ts: new Date().toISOString(),
        type: "pattern",
        scope: "Babylon.js",
        content: "Run Babylon.js unit tests with npx vitest run from the repo root.",
      }) + "\n",
    );
    const loaded = await loadPlugin(dir());

    const event: { sessionID: string; prompt: { text: string } } = {
      sessionID: "ses_x",
      prompt: { text: "run the unit tests for Babylon.js" },
    };
    await loaded.sessionHooks["prompt"]!(event);

    // Prompt text is stored verbatim and rendered in the UI — it must never carry injected memory.
    expect(event.prompt.text).toBe("run the unit tests for Babylon.js");

    const delivered: { sessionID: string; system: Array<{ type: string; text: string }> } = {
      sessionID: "ses_x",
      system: [],
    };
    await loaded.sessionHooks["context"]!(delivered);
    expect(delivered.system.map((part) => part.text).join("\n")).toContain("npx vitest run"); // relevant memory via system channel
  });

  test("session.prompt fails closed (text untouched, nothing stashed) when nothing matches", async () => {
    const loaded = await loadPlugin(dir());
    const event: { sessionID: string; prompt: { text: string } } = {
      sessionID: "ses_x",
      prompt: { text: "zzz nothing relevant here" },
    };
    await loaded.sessionHooks["prompt"]!(event);
    expect(event.prompt.text).toBe("zzz nothing relevant here");
    const delivered: { sessionID: string; system: Array<{ type: string; text: string }> } = {
      sessionID: "ses_x",
      system: [],
    };
    await loaded.sessionHooks["context"]!(delivered);
    expect(delivered.system.map((part) => part.text).join("\n")).not.toContain("zzz");
  });

  test("session.context pushes the memory digest as a system text part", async () => {
    mkdirSync(memoryRoot(), { recursive: true });
    appendFileSync(
      join(memoryRoot(), "2026-09-18.logfmt"),
      formatLine({ ts: new Date().toISOString(), type: "pattern", scope: "engine", content: "build with npm run build:source" }) + "\n",
    );
    const loaded = await loadPlugin(dir());
    const event: { sessionID: string; system: Array<{ type: string; text: string }> } = {
      sessionID: "ses_ctx",
      system: [],
    };
    await loaded.sessionHooks["context"]!(event);
    expect(event.system).toHaveLength(1);
    expect(event.system[0].type).toBe("text");
    expect(event.system[0].text).toContain("## Persistent memory");
    // With no query, the digest advertises recall rather than injecting rows.
    expect(event.system[0].text).toContain("Check memory_recall BEFORE grepping or reading");
    expect(event.system[0].text).toContain("Relevant memories are also auto-injected when your message matches.");
  });
});
