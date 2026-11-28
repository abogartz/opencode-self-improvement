import { expect, test } from "bun:test";
import { appendMemory } from "../../src/store/files/append.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";
import { withTempStore } from "../helpers/temp-store.ts";
import { runScenario } from "./scenario.ts";
import { captureLagLines } from "../../src/status/metrics.ts";
import { summarizeHarnessActivity } from "../../src/status/harness-stats.ts";

const store = withTempStore({ prefix: "osi-harness-stats-" });
const FACT =
  "The azurite release requires the cobalt manifest before deployment.";

test("mixed per-message reasoning coverage retains all completion tokens through streaming replacements", async () => {
  await runScenario("partial reasoning receipts", async (s) => {
    const h = s.host("meter", { directory: store.root });
    await h.start();
    await h.request("meter", "show usage");
    await h.emit("usage", {
      sessionID: "meter",
      messageID: "a",
      input: 100,
      read: 0,
      write: 0,
      output: 20,
      reasoning: 5,
    });
    await h.emit("usage", {
      sessionID: "meter",
      messageID: "b",
      input: 200,
      read: 0,
      write: 0,
      output: 40,
    });
    await h.emit("usage", {
      sessionID: "meter",
      messageID: "b",
      input: 200,
      read: 0,
      write: 0,
      output: 45,
    });
    const report = (await h.invoke("meter", "memory_status", {})).content;
    expect(report).toInclude(
      "70 completion tok — reasoning split not reported",
    );
    const stats = summarizeHarnessActivity(await captureLagLines(), []);
    expect(stats.total.usage).toMatchObject({
      input: 300,
      output: 70,
      reasoning: null,
    });
  });
});

test("stable accounting survives runtime replacement and missing reasoning stays unknown in mixed totals", async () => {
  await runScenario("restarted usage accounting", async (s) => {
    const oc = s.host("oc", { directory: store.root, harness: "opencode" });
    const first = s.host("first", {
      directory: store.root,
      harness: "oh-my-pi",
    });
    await oc.start();
    await first.start();
    await oc.emit("usage", {
      sessionID: "oc",
      cumulative: true,
      input: 100,
      read: 10,
      write: 2,
      output: 20,
      reasoning: 5,
    });
    await first.emit("usage", {
      sessionID: "transient-1",
      accountingID: "persistent",
      cumulative: true,
      input: 200,
      read: 20,
      write: 4,
      output: 30,
    });
    await first.close();
    const resumed = s.host("resumed", {
      directory: store.root,
      harness: "oh-my-pi",
    });
    await resumed.start();
    await resumed.emit("usage", {
      sessionID: "transient-2",
      accountingID: "persistent",
      cumulative: true,
      input: 250,
      read: 25,
      write: 5,
      output: 40,
    });
    const stats = summarizeHarnessActivity(await captureLagLines(), []);
    expect(stats.total.usage).toEqual({
      sessions: 2,
      input: 350,
      read: 35,
      write: 7,
      output: 60,
      reasoning: null,
    });
    expect(
      stats.harnesses.find((g) => g.harness === "opencode")?.usage?.reasoning,
    ).toBe(5);
    expect(
      stats.harnesses.find((g) => g.harness === "oh-my-pi")?.usage?.sessions,
    ).toBe(1);
    expect(
      (await resumed.invoke("transient-2", "memory_status", {})).content,
    ).toInclude("reasoning not reported for every session");
  });
});

test("one shared store reports combined activity and each harness without partitioning memories", async () => {
  await runScenario("shared harness statistics", async (s) => {
    const a = s.host("a", { directory: store.root, harness: "opencode" });
    const b = s.host("b", { directory: store.root, harness: "oh-my-pi" });
    await a.start();
    await b.start();
    await appendMemory({
      type: "learning",
      scope: "azurite",
      content: FACT,
      repo: "global",
    });
    for (const h of [a, b]) {
      expect(
        await h.request("reader", "azurite release cobalt manifest"),
      ).toInclude(FACT);
      expect(
        (
          await h.invoke("reader", "memory_recall", {
            query: "azurite release cobalt manifest",
          })
        ).content,
      ).toInclude(FACT);
    }
    // Same raw IDs on different harnesses must not share per-message usage receipts.
    await a.emit("usage", {
      sessionID: "reader",
      messageID: "a",
      input: 100,
      read: 20,
      write: 5,
      output: 10,
      reasoning: 2,
    });
    await b.emit("usage", {
      sessionID: "reader",
      messageID: "b",
      input: 200,
      read: 40,
      write: 10,
      output: 20,
      reasoning: 4,
    });
    await a.emit("usage", {
      sessionID: "reader",
      messageID: "a",
      input: 100,
      read: 20,
      write: 5,
      output: 10,
      reasoning: 2,
    });
    const report = (await b.invoke("reader", "memory_status", {})).content;
    expect(report).toInclude("HARNESS ACTIVITY");
    expect(report).toInclude("all harnesses");
    for (const harness of ["opencode", "oh-my-pi"])
      expect(report).toInclude(
        `${harness}: credited retrievals inject 1 / pull 0 / recall 1`,
      );
    expect(report).toInclude("input 300");
    expect(report).toInclude("input 100");
    expect(report).toInclude("input 200");
    expect(report).toInclude("1 active");
    const loads = readEvidenceLog().filter((row) => row.ev === "plugin_load");
    expect(loads.map((row) => row.harness).sort()).toEqual([
      "oh-my-pi",
      "opencode",
    ]);
    // A fresh reader reconstructs totals from disk, not the reporting runtime's counters.
    const reader = s.host("reader", { directory: store.root, harness: "dsh" });
    await reader.start();
    const later = (await reader.invoke("later", "memory_status", {})).content;
    expect(later).toInclude("input 300");
    expect(later).toInclude("not reported");
  });
});

test("capture retains its harness while another host runs before the model completes", async () => {
  await runScenario("capture attribution", async (s) => {
    const a = s.host("a", {
      directory: store.root,
      harness: "opencode",
      options: { autoCapture: true },
    });
    const b = s.host("b", { directory: store.root, harness: "oh-my-pi" });
    await a.start();
    await b.start();
    await a.ground("capture");
    a.transcripts.set("capture", [
      {
        role: "user",
        text: `${FACT} This release is finished and the manifest was verified. Remember the deployment convention when preparing the next staging release and checking the archive importer. The final verification succeeded and there are no remaining changes to apply.`,
      },
    ]);
    const held = a.generation.pause("capture completion");
    const capturing = a.turnEnd("capture");
    await held.entered;
    await b.request("other", "unrelated request");
    held.resolve("[]");
    await capturing;
    const costs = readEvidenceLog().filter((row) => row.ev === "capture_cost");
    expect(costs).toHaveLength(1);
    expect(costs[0]?.harness).toBe("opencode");
  });
});
