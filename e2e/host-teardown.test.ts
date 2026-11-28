import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadFailure,
  makeGuest,
  resolveOpencode,
  startFake,
  turn,
} from "./support/harness.ts";
import { DELAYS_MS } from "./support/teardown-probe-plugin/index.ts";
import { startServer } from "./support/server.ts";

const TRIALS = 3;

test("cooperative server shutdown invokes and awaits asynchronous plugin cleanup", async () => {
  const fake = await startFake();
  const guest = makeGuest(
    fake,
    join(import.meta.dir, "support", "teardown-probe-plugin"),
  );
  const file = join(guest.root, "cleanup-receipts.txt");
  guest.env.TEARDOWN_PROBE_OUT = file;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer(guest);
    fake.setSteps({ "TEARDOWN-PROBE": [{ content: "done" }] });
    const run = await turn(fake, guest, "TEARDOWN-PROBE", 60_000, server.url);
    expect(
      loadFailure(run),
      `${run.stderr}\n${JSON.stringify(run.errors())}`,
    ).toBeUndefined();
    await server.stop();
    const receipts = readFileSync(file, "utf8").trim().split("\n");
    expect(receipts).toContain("cleanup-start");
    expect(receipts).toContain("cleanup-end");
  } finally {
    await server?.stop();
    fake.stop();
    rmSync(guest.root, { recursive: true, force: true });
  }
}, 120_000);

test("reports which turn-end handler waits survive OpenCode shutdown", async () => {
  const fake = await startFake();
  try {
    const guest = makeGuest(
      fake,
      join(import.meta.dir, "support", "teardown-probe-plugin"),
    );
    try {
      const version = Bun.spawnSync([resolveOpencode(), "--version"], {
        cwd: guest.projDir,
        env: guest.env,
      });
      expect(version.exitCode).toBe(0);
      const host = version.stdout.toString().trim();
      expect(host).not.toBe("");

      const output = join(guest.root, "teardown-receipts.txt");
      guest.env.TEARDOWN_PROBE_OUT = output;
      fake.setSteps({ "TEARDOWN-PROBE": [{ content: "done" }] });

      const trials: Set<string>[] = [];
      for (let i = 0; i < TRIALS; i++) {
        rmSync(output, { force: true });
        const run = await turn(fake, guest, "TEARDOWN-PROBE", 60_000);
        expect(loadFailure(run), run.stderr).toBeUndefined();
        expect(run.text()).toContain("done");
        expect(existsSync(output), "probe produced no receipts").toBe(true);
        const receipts = new Set(
          readFileSync(output, "utf8").trim().split("\n"),
        );
        expect(receipts.has("subscribed")).toBe(true);
        expect(
          Array.from(receipts).filter((line) => line.startsWith("error:")),
        ).toEqual([]);
        trials.push(receipts);
      }

      const count = (receipt: string) =>
        trials.filter((receipts) => receipts.has(receipt)).length;
      const arrived = count("arrived");
      console.log(
        `[teardown-cleanup] start=${count("cleanup-start")} end=${count("cleanup-end")} beforeExit=${count("beforeExit")} exit=${count("exit")}`,
      );
      const completion = DELAYS_MS.map(
        (ms) => `${ms}ms=${count(`timer:${ms}`)}/${arrived}`,
      ).join(" ");
      console.log(
        `[teardown-probe] ${host} (${process.platform}) arrived=${arrived}/${TRIALS} microtask=${count("microtask")}/${arrived} ${completion}`,
      );
      expect(arrived, "no turn-end events reached the probe").toBeGreaterThan(
        0,
      );
      // Short timers can finish opportunistically during shutdown.
      const revisit =
        "Re-measure before revisiting the pre-receipt blind band and auto_capture_dispose diagnosis.";
      if (count("timer:200") > 0) {
        console.warn(
          `[teardown-probe] ${host} completed the 200 ms rung. ${revisit}`,
        );
      } else if (count("timer:50") > 0) {
        console.log(
          `[teardown-probe] ${host} observed a 50 ms completion. ${revisit}`,
        );
      }
    } finally {
      rmSync(guest.root, { recursive: true, force: true });
    }
  } finally {
    fake.stop();
  }
}, 240_000);
