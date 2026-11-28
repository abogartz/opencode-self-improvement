import { readFileSync } from "node:fs";
import { hitsFile } from "../../src/telemetry/ledger.ts";
import { parseLine } from "../../src/core/logfmt/format.ts";
import type { TestHost } from "./host.ts";
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runScenario } from "./scenario.ts";
import { withTempStore } from "../helpers/temp-store.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { resolveRepo } from "../../src/identity/repokey.ts";
import { readEvidenceLog } from "../helpers/logfmt.ts";
import { captureCursor } from "../../src/capture/policy.ts";
import { resetCaptureCooldowns } from "../../src/runtime/capture.ts";

const store = withTempStore({ prefix: "osi-simulator-" });
const FACT = "The nightly archive job keeps fourteen days of tarballs.";
const messages = [
  {
    role: "user" as const,
    text: `${FACT} The archive change is finished and the importer respects the staging limit. Remember the retention policy when wiring the archive importer and preparing the next deployment to the staging environment.`,
  },
];
const answer = JSON.stringify([
  { type: "context", scope: "archive", content: FACT, status: "settled" },
]);

for (const captureDelta of [false, true])
  test(`recent capture keeps source cursors with captureDelta=${captureDelta}`, async () => {
    await runScenario("long transcript", async (s) => {
      const h = s.host("host", {
        directory: project("a"),
        options: { autoCapture: true, captureDelta, captureOnSignal: true },
      });
      const history = Array.from({ length: 45 }, (_, i) => [
        {
          role: "user" as const,
          text:
            `Remember that ARCHIVE-TURN-${i} is the deployment checkpoint. ` +
            "Details of the completed archive operation. ".repeat(6),
        },
        { text: "" },
        { role: "assistant" as const, text: `Confirmed checkpoint ${i}.` },
      ]).flat();
      h.transcripts.set("writer", history);
      await h.start();
      await h.turnEnd("writer");
      expect(h.generation.calls[0]?.prompt).toInclude("ARCHIVE-TURN-44");
      expect(h.generation.calls[0]?.prompt).not.toInclude("ARCHIVE-TURN-0 ");
      expect(captureCursor("writer").msgs).toBe(history.length);
      resetCaptureCooldowns();
      h.transcripts.set("writer", [...history, ...messages]);
      await h.turnEnd("writer");
      expect(h.generation.calls[1]?.prompt).toInclude(FACT);
      if (captureDelta)
        expect(h.generation.calls[1]?.prompt).not.toInclude("ARCHIVE-TURN-");
      expect(captureCursor("writer").msgs).toBe(
        history.length + messages.length,
      );
      resetCaptureCooldowns();
      h.transcripts.set("writer", messages);
      await h.turnEnd("writer");
      expect(h.generation.calls[2]?.prompt).toInclude(FACT);
      expect(captureCursor("writer").msgs).toBe(messages.length);
    });
  });

test("capture cancels when ownership changes during model lookup", async () => {
  await runScenario("move before transcript", async (s) => {
    const h = s.host("host", {
      directory: project("a"),
      options: { autoCapture: true },
    });
    h.transcripts.set("writer", messages);
    await h.start();
    await h.ground("writer");
    const lookup = h.modelReads.pause("model lookup");
    const capture = h.turnEnd("writer");
    await lookup.entered;
    await h.move("writer", project("b"));
    h.transcripts.set("writer", [
      { role: "user", text: "Project B private facts. ".repeat(20) },
    ]);
    lookup.resolve({ providerID: "fake", id: "model" });
    await capture;
    expect(h.generation.calls).toHaveLength(0);
    expect(await loadAll()).toEqual([]);
  });
});

test("usage emitted before identity resolves stays private to its session", async () => {
  await runScenario("unresolved usage", async (s) => {
    const h = s.host("host", {});
    await h.start();
    await h.emit("usage", {
      sessionID: "private-writer",
      input: 123,
      read: 0,
      write: 0,
      output: 9,
    });
    const args = {
      date: new Date().toISOString().slice(0, 10),
      ev: "session_usage",
    };
    expect((await h.invoke("other", "memory_evidence", args)).content).toBe(
      "No evidence",
    );
    expect(
      (await h.invoke("private-writer", "memory_evidence", args)).content,
    ).toContain("input=123");
  });
});

function project(name: string) {
  const dir = join(store.root, name);
  mkdirSync(dir);
  return dir;
}

test("scripted capture keeps its original repository when another session runs and the writer moves", async () => {
  const a = project("a");
  const b = project("b");
  await runScenario("move during generation", async (s) => {
    const h = s.host("host", { directory: a, options: { autoCapture: true } });
    h.transcripts.set("writer", messages);
    await h.start();
    await h.ground("writer");
    const model = h.generation.pause("writer model");
    const captured = h.turnEnd("writer");
    expect((await model.entered).prompt).toInclude(FACT);
    await h.move("writer", b);
    await h.request("other-session", "unrelated penguin migration");
    model.resolve(answer);
    await captured;
    const rows = await loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe(FACT);
    expect(rows[0]?.repo).toBe(resolveRepo(a).key);
    const lag = readEvidenceLog().find((line) => line.ev === "capture_lag");
    expect(lag?.repo).toBe(resolveRepo(a).key);
  });
});

test("dispose during a paused transcript ignores queued turn ends and late hooks", async () => {
  await runScenario("dispose before transcript", async (s) => {
    const h = s.host("host", {
      directory: project("a"),
      options: { autoCapture: true },
    });
    await h.start();
    const transcript = h.transcriptReads.pause("transcript");
    const first = h.turnEnd("writer");
    await transcript.entered;
    const duplicate = h.turnEnd("writer");
    const cleanup = h.dispose();
    transcript.resolve(messages);
    await Promise.all([cleanup, first, duplicate]);
    const before = readEvidenceLog();
    await h.emit("compact", { sessionID: "writer", transcript: messages });
    await h.turnEnd("writer");
    expect(h.generation.calls).toHaveLength(0);
    expect(await loadAll()).toEqual([]);
    expect(readEvidenceLog()).toEqual(before);
    expect(s.trace.entries.some((e) => e.event === "compact.dropped")).toBe(
      true,
    );
  });
});

test("failed generation is contained and the next session still captures", async () => {
  await runScenario("generation failure then recovery", async (s) => {
    const h = s.host("host", {
      directory: project("a"),
      options: { autoCapture: true },
    });
    await h.start();
    for (const sid of ["failed", "recovered"]) {
      h.transcripts.set(sid, messages);
      await h.ground(sid);
    }
    h.generation.fail(new Error("scripted model failure"));
    await h.turnEnd("failed");
    h.generation.reply(answer);
    await h.turnEnd("recovered");
    expect(h.generation.calls).toHaveLength(2);
    expect((await loadAll()).map((row) => row.content)).toEqual([FACT]);
    expect(
      readEvidenceLog().some(
        (line) =>
          line.ev === "auto_capture_refused" && line.reason === "capture_threw",
      ),
    ).toBe(true);
  });
});

test("clipped pull delivery is not credited; duplicate complete observations are credited once", async () => {
  await runScenario("clipped delivery", async (s) => {
    const h = s.host("host", { directory: project("a") });
    await h.start();
    await h.ground("writer");
    expect(
      (
        await h.invoke("writer", "memory_remember", {
          type: "learning",
          scope: "archive",
          content: FACT,
          status: "settled",
        })
      ).content,
    ).toStartWith("Remembered:");
    await h.emit("prompt", {
      sessionID: "reader",
      text: "archive job tarballs",
    });
    const clipped = await h.toolResult("reader", "clipped", FACT, {
      clip: FACT.length,
    });
    await h.context("reader", { observedResults: [clipped] });
    const pullHits = () =>
      readFileSync(hitsFile(), "utf8")
        .split("\n")
        .map(parseLine)
        .filter((line) => line?.ev === "memory_used" && line.src === "pull");
    expect(pullHits()).toHaveLength(0);
    const full = await h.toolResult("reader", "full", FACT);
    expect(full.text).toInclude("Related durable memory");
    await Promise.all([
      h.context("reader", { observedResults: [full, full] }),
      h.context("reader", { observedResults: [full] }),
    ]);
    expect(pullHits()).toHaveLength(1);
  });
});

test("scenario failures include an ordered trace and release paused calls", async () => {
  let h: TestHost | undefined;
  await expect(
    runScenario("intentional failure", async (s) => {
      h = s.host("host", {
        directory: project("a"),
        options: { autoCapture: true },
      });
      await h.start();
      h.transcripts.set("writer", messages);
      const paused = h.generation.pause("held answer");
      void h.turnEnd("writer");
      await paused.entered;
      throw new Error("intentional assertion");
    }),
  ).rejects.toThrow(
    /intentional assertion[\s\S]*generation.paused[\s\S]*dispose/,
  );
  expect(h!.generation.calls[0]!.sessionID).toBe("writer");
  expect(h!.generationSignals[0]!.aborted).toBe(true);
  expect(h?.closed).toBe(true);
});

test("registration failure remains inert and disposal can be held while late hooks are dropped", async () => {
  await runScenario("registration and disposal faults", async (s) => {
    const failed = s.host("failed");
    failed.registration.fail(new Error("registration refused"));
    await expect(failed.start()).rejects.toThrow("registration refused");
    await expect(failed.invoke("s", "memory_recall", {})).rejects.toThrow(
      "not active",
    );
    const h = s.host("working");
    await h.start();
    const held = h.disposal.pause("dispose");
    const closing = h.dispose();
    await held.entered;
    await h.emit("prompt", { sessionID: "late", text: "late" });
    expect(s.trace.entries.some((e) => e.event === "prompt.dropped")).toBe(
      true,
    );
    held.resolve(undefined);
    await closing;
  });
});

test("missing generation leaves manual tools available and delivery sinks are controllable", async () => {
  await runScenario("capability and delivery controls", async (s) => {
    const h = s.host("host", {
      directory: project("a"),
      options: { autoCapture: true },
      capabilities: { generation: false },
    });
    await h.start();
    expect(h.tools.size).toBe(14);
    await h.ground("writer");
    expect(
      (
        await h.invoke("writer", "memory_remember", {
          type: "learning",
          scope: "archive",
          content: FACT,
          status: "settled",
        })
      ).content,
    ).toStartWith("Remembered:");
    await expect(h.turnEnd("s")).rejects.toThrow("unavailable");
    const absent = await h.context("absent", { system: false });
    expect(absent.attemptedSystem).toEqual([]);
    const clipped = await h.context("clipped", { clip: 7 });
    expect(clipped.attemptedSystem.length).toBeGreaterThan(0);
    expect(clipped.system).toEqual(
      clipped.attemptedSystem.map((text) => text.slice(0, 7)),
    );
    expect(h.requests).toHaveLength(2);
  });
});

test("failed scenarios cancel setup parked at registration before releasing the store", async () => {
  let h: TestHost | undefined;
  await expect(
    runScenario("held registration", async (s) => {
      h = s.host("host");
      const held = h.registration.pause("register");
      void h.start();
      await held.entered;
      throw new Error("stop setup");
    }),
  ).rejects.toThrow(/stop setup[\s\S]*setup.failed[\s\S]*dispose.end/);
  expect(h?.closed).toBe(true);
});

test("two hosts can answer captures in reverse order without exchanging repository ownership", async () => {
  const a = project("a");
  const b = project("b");
  await runScenario("reverse model completions", async (s) => {
    const left = s.host("left", {
      directory: a,
      options: { autoCapture: true },
    });
    const right = s.host("right", {
      directory: b,
      options: { autoCapture: true },
    });
    await left.start();
    await right.start();
    left.transcripts.set("left-session", messages);
    right.transcripts.set("right-session", messages);
    await left.ground("left-session");
    await right.ground("right-session");
    const first = left.generation.pause("first capture");
    const second = right.generation.pause("second capture");
    const leftTurn = left.turnEnd("left-session");
    const rightTurn = right.turnEnd("right-session");
    await Promise.all([first.entered, second.entered]);
    second.resolve(answer);
    await rightTurn;
    expect((await loadAll()).map((row) => row.repo)).toEqual([
      resolveRepo(b).key,
    ]);
    first.resolve(answer);
    await leftTurn;
    expect((await loadAll()).map((row) => row.repo).sort()).toEqual(
      [resolveRepo(a).key, resolveRepo(b).key].sort(),
    );
  });
});
