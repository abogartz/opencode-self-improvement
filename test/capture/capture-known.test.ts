import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildCapturePrompt } from "../../src/capture/prompt.ts";
import { formatLine } from "../../src/core/logfmt/format.ts";
import {
  rememberSessionDir,
  sessionScope,
} from "../../src/identity/repokey.ts";
import { resetCaptureCooldowns, resetSessionModels } from "../../src/index.ts";
import { loadPlugin, withTempStore } from "../harness.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("capture checkpoint timed out");
    await Bun.sleep(5);
  }
}

describe("capture known-row context", () => {
  const fixture = withTempStore({ prefix: "osi-capture-known-" });
  describe("capture input", () => {
    let plugin: Awaited<ReturnType<typeof loadPlugin>> | undefined;
    let sequence = 0;
    beforeEach(() => {
      resetCaptureCooldowns();
      resetSessionModels();
      sequence = 0;
    });
    afterEach(async () => {
      await plugin?.cleanup();
      plugin = undefined;
    });
    function seed(content: string, owner: string, tags?: string[]) {
      const scope = sessionScope(owner);
      mkdirSync(fixture.memoryDir, { recursive: true });
      appendFileSync(
        join(fixture.memoryDir, "2026-11-08.logfmt"),
        formatLine({
          ts: `2026-11-08T00:00:${String(sequence++).padStart(2, "0")}.000Z`,
          type: "context",
          scope: "capture",
          content,
          repo: scope?.key,
          repoPath: scope?.path,
          tags: tags?.join(","),
        }) + "\n",
      );
    }
    const messages = [
      {
        role: "user",
        content:
          "The session finished a deployment migration and verified the staging manifests. ".repeat(
            5,
          ),
      },
    ];
    async function start(sid: string) {
      const repo = join(fixture.root, "repo-a");
      mkdirSync(repo);
      rememberSessionDir(sid, repo);
      plugin = await loadPlugin(repo, {
        autoCapture: true,
        captureModel: "fake/model",
      });
      plugin.capture.context.messages = messages;
      plugin.capture.generate.response = "[]";
      await waitFor(() => plugin!.capture.events.subscribeCalls === 2);
      return { plugin, repo };
    }
    async function fire(sid: string) {
      plugin!.capture.events.push({
        type: "session.execution.succeeded",
        data: { sessionID: sid },
      });
      await waitFor(() =>
        readEvidenceLog().some(
          (e) => e.ev === "capture_lag" && e.session === sid,
        ),
      );
      return plugin!.capture.generate.calls[0].prompt;
    }

    test("the contract bans suite-authority claims and redacts direct known input", () => {
      const token = "sk-proj-" + "A".repeat(120);
      const prompt = buildCapturePrompt("session work", 3, "", token);
      expect(prompt).toContain("never claim what hidden tests");
      expect(prompt).not.toContain(token);
      expect(prompt).toContain("[redacted]");
      expect(buildCapturePrompt("session work")).not.toContain(
        "Already stored for this repo",
      );
    });

    test("known rows are newest-first, capped, scoped and exclude quarantine", async () => {
      const { repo } = await start("known-bounds");
      const other = join(fixture.root, "repo-b");
      mkdirSync(other);
      rememberSessionDir("other-owner", other);
      for (let n = 0; n < 20; n++)
        seed(
          `KEEP_${String(n).padStart(3, "0")} ordinary remembered deployment fact.`,
          "known-bounds",
        );
      seed("QUARANTINE_ONLY remembered instruction.", "known-bounds", [
        "quarantine",
      ]);
      seed("OTHER_REPO_ONLY private remembered fact.", "other-owner");
      const prompt = await fire("known-bounds");
      expect(prompt.match(/^- capture: KEEP_/gm)).toHaveLength(15);
      expect(prompt).toContain("KEEP_019");
      expect(prompt).not.toContain("KEEP_004");
      expect(prompt).not.toContain("QUARANTINE_ONLY");
      expect(prompt).not.toContain("OTHER_REPO_ONLY");
      expect(sessionScope("known-bounds")?.path).toBe(repo);
    });

    test("a session move during context read cannot switch the known-row owner", async () => {
      const { plugin, repo } = await start("known-move");
      const other = join(fixture.root, "repo-b");
      mkdirSync(other);
      rememberSessionDir("other-owner", other);
      const token = "sk-proj-" + "A".repeat(120);
      seed(
        `A_ONLY known API credential ${token} and a deployment note.`,
        "known-move",
      );
      seed("B_ONLY private repo-b guide.", "other-owner");
      let release!: (value: unknown) => void;
      plugin.capture.context.messages = new Promise((resolve) => {
        release = resolve;
      });
      plugin.capture.events.push({
        type: "session.execution.succeeded",
        data: { sessionID: "known-move" },
      });
      try {
        await waitFor(() =>
          plugin.capture.context.calls.includes("known-move"),
        );
        plugin.capture.events.push({
          type: "session.moved",
          location: { directory: repo },
          data: { sessionID: "known-move", location: { directory: other } },
        });
        await waitFor(() => sessionScope("known-move")?.path === other);
      } finally {
        release(messages);
      }
      await waitFor(() =>
        readEvidenceLog().some(
          (e) =>
            e.ev === "auto_capture_skipped" &&
            e.reason === "session_moved" &&
            e.session === "known-move",
        ),
      );
      expect(plugin.capture.generate.calls).toHaveLength(0);
    });
  });
});
