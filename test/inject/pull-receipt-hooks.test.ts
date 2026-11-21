// The registered host hooks place the pull in
// tool.execute.after, a later plugin may still rewrite the result, and the
// ledger credit waits for the session.context request that carries the call.
// e2e/pull-attribution.test.ts measures the same contract against the real
// host; this pins the hook lifecycle without one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseLine } from "../../src/core/logfmt/format.ts";
import { readLines } from "../../src/core/logfmt/read.ts";
import { peekTurn, resetState } from "../../src/core/state.ts";
import {
  resetSessionScopes,
  setRepoScope,
} from "../../src/identity/repokey.ts";
import { PULL_HEADER } from "../../src/inject/pull.ts";
import { withStoreLock } from "../../src/store/lock.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import {
  hitsFile,
  readRides,
  readOutcomes,
  recordOutcome,
  joinUseWithOutcomes,
  resetHitThrottle,
  resetLedgerCache,
} from "../../src/telemetry/ledger.ts";
import { type LoadedPlugin, loadPlugin } from "../harness.ts";
import { ev, readEvidenceLog } from "../helpers/logfmt.ts";
import { removeStore } from "../helpers/remove-store.ts";

const envKeys = ["OPENCODE_MEMORY_DIR", "OPENCODE_COMMANDS_DIR"] as const;
let savedEnv: Record<string, string | undefined>;
let root: string;
let repo: string;
let plugins: LoadedPlugin[];

function resetGlobals(): void {
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  resetHitThrottle();
  resetLedgerCache();
}

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "osi-pull-receipt-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  plugins = [];
  resetGlobals();
});

afterEach(async () => {
  for (const p of plugins) await p.cleanup();
  resetGlobals();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith("osi-pull-receipt-")
  ) {
    throw new Error("Unexpected fixture cleanup target");
  }
  removeStore(root);
});

const CUE = "ERR_MODULE_NOT_FOUND vite.config.ts";
const ROW = `${CUE} PULL-RECEIPT-462 requires a clean checkout.`;
// Long enough that a 200-character limiter ends inside the original output.
const OUTPUT = `${CUE}\n${"padding ".repeat(40)}`;

async function plugin(): Promise<LoadedPlugin> {
  const p = await loadPlugin(repo);
  plugins.push(p);
  return p;
}

// One read through the registered execute.after hook, in the V2 shape a
// v2.3 host hands it. Returns the event so a test can play a later plugin.
async function read(
  p: LoadedPlugin,
  sid: string,
  callID?: string,
  output = OUTPUT,
) {
  const event = {
    sessionID: sid,
    callID,
    tool: "read",
    // The file path also enters the recall query. Keep the temp directory's
    // "pull-receipt" words from matching a seeded row on unrelated reads.
    input: { filePath: "notes.txt" },
    result: { content: [{ type: "text", text: output }] },
  };
  await p.toolHooks["execute.after"](event);
  return event;
}

const textOf = (event: Awaited<ReturnType<typeof read>>) =>
  event.result.content.map((part) => part.text).join("\n");

// The next request, carrying the call's tool-result as the host built it
// from the result object every execute.after hook has finished with.
async function request(
  p: LoadedPlugin,
  sid: string,
  callID: string,
  text: string,
  ...others: { id: string; text: string }[]
) {
  await p.sessionHooks.context({
    sessionID: sid,
    system: [],
    messages: [
      {
        role: "tool",
        content: [{ id: callID, text }, ...others].map(({ id, text }) => ({
          type: "tool-result",
          id,
          name: "read",
          result: { type: "content", value: [{ type: "text", text }] },
        })),
      },
    ],
  });
}

async function pullCredits() {
  if (!existsSync(hitsFile())) return [];
  return (await readLines(hitsFile()))
    .map(parseLine)
    .filter((line) => line?.src === "pull");
}

describe("Feature: a pull is credited by the request that carries it", () => {
  test("Scenario: no later plugin — the row is credited on the next request, with the placement's turn", async () => {
    const row = await appendMemory({
      type: "learning",
      scope: "fixture",
      content: ROW,
      repo: "global",
    });
    const p = await plugin();
    const sid = "ses-receipt-kept";
    await p.sessionHooks.prompt({ sessionID: sid, prompt: { text: "go" } });
    const event = await read(p, sid, "call-kept");
    expect(textOf(event)).toContain(PULL_HEADER);
    expect(textOf(event)).toContain(ROW);
    // Placed, not yet delivered: nothing is credited at the hook.
    expect(await pullCredits()).toEqual([]);

    // A new turn starts before the request settles the call. The credit
    // still names the turn the ride landed on.
    await p.sessionHooks.prompt({ sessionID: sid, prompt: { text: "next" } });
    await request(p, sid, "call-kept", textOf(event));
    const credits = await pullCredits();
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      ev: "memory_used",
      sid,
      mem: `[${row}]`,
      turn: "1",
    });

    // Every later request re-sends the same tool-result: no second credit.
    resetHitThrottle();
    await request(p, sid, "call-kept", textOf(event));
    expect(await pullCredits()).toHaveLength(1);
  });

  test("Scenario: a later limiter trims the block — no credit, and the loss is a count", async () => {
    await appendMemory({
      type: "learning",
      scope: "fixture",
      content: ROW,
      repo: "global",
    });
    const p = await plugin();
    const sid = "ses-receipt-trimmed";
    await p.sessionHooks.prompt({ sessionID: sid, prompt: { text: "go" } });
    const event = await read(p, sid, "call-trimmed");
    expect(textOf(event)).toContain(ROW);
    // Keep the header so the request identifies this placement, then clip its row.
    const clipped = textOf(event)
      .split("\n")
      .filter((line) => !line.includes(ROW))
      .join("\n");
    event.result.content = [{ type: "text", text: clipped }];

    resetSessionScopes();
    setRepoScope(null);
    await request(p, sid, "call-trimmed", textOf(event));
    expect(await pullCredits()).toEqual([]);
    const lost = ev(readEvidenceLog(), "pull_undelivered");
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({
      tool: "read",
      rows: "1",
      stage: "request",
    });
    // Counts only: the loss line names the tool and a row count, never the
    // row or the tool output. (tool_result's own output summary is a
    // separate, pre-existing evidence line and not this contract.)
    expect(Object.keys(lost[0]).sort()).toEqual(
      ["ev", "repo", "repoPath", "rows", "stage", "tool", "ts"].sort(),
    );
    const evidence = [...lost, ...ev(readEvidenceLog(), "pull_unconfirmed")]
      .map((line) => JSON.stringify(line))
      .join("\n");
    expect(evidence).not.toContain("PULL-RECEIPT-462");
    expect(evidence).not.toContain("padding");
  });

  test("a quoted earlier block and a repeated static footer do not change attribution", async () => {
    await appendMemory({
      type: "learning",
      scope: "fixture",
      content: ROW,
      repo: "global",
    });
    const p = await plugin();
    const sid = "ses-quote";
    const first = textOf(await read(p, sid, "reused"));
    const second = textOf(await read(p, sid, "reused"));
    expect(first).not.toBe(second);
    await request(p, sid, "reused", first);
    expect(await pullCredits()).toEqual([]);
    expect(ev(readEvidenceLog(), "pull_undelivered")).toHaveLength(0);
    const third = textOf(await read(p, sid, "reused"));
    await request(p, sid, "reused", third + "\n" + PULL_HEADER);
    expect(await pullCredits()).toHaveLength(1);
  });

  test("a read without a call ID records a scoped count and earns no credit", async () => {
    await appendMemory({
      type: "learning",
      scope: "fixture",
      content: ROW,
      repo: "global",
    });
    const p = await plugin();
    const event = await read(p, "ses-unmatched");
    expect(textOf(event)).toContain(ROW);
    const loss = ev(readEvidenceLog(), "pull_unconfirmed");
    expect(loss).toHaveLength(1);
    expect(loss[0]).toMatchObject({
      reason: "no_call",
      tool: "read",
      rows: "1",
      repoPath: repo,
    });
    expect(JSON.stringify(loss)).not.toContain(ROW);
    expect(await pullCredits()).toEqual([]);
  });

  test("a gate completed before the context observation cannot be an outcome of that pull", async () => {
    const id = await appendMemory({
      type: "learning",
      scope: "fixture",
      content: ROW,
      repo: "global",
    });
    const p = await plugin();
    const sid = "ses-batched-gate";
    await p.sessionHooks.prompt({ sessionID: sid, prompt: { text: "go" } });
    const event = await read(p, sid, "call-before-gate");
    const turn = peekTurn(sid)!;
    await Bun.sleep(5);
    const gateTime = Date.now();
    expect(
      await recordOutcome(sid, turn.turn, "PASS", "test", gateTime, turn.key),
    ).toBe(true);
    await Bun.sleep(5);
    await request(p, sid, "call-before-gate", textOf(event));
    const rides = await readRides();
    const pulled = rides.filter((r) => r.src === "pull");
    expect(pulled).toHaveLength(1);
    expect(Date.parse(pulled[0]!.ts!)).toBeGreaterThan(gateTime);
    expect(
      joinUseWithOutcomes(pulled, await readOutcomes()).get(id)?.joined,
    ).toBe(0);
    expect(
      await recordOutcome(
        sid,
        turn.turn,
        "PASS",
        "test",
        Date.now() + 1,
        turn.key,
      ),
    ).toBe(true);
    expect(
      joinUseWithOutcomes(pulled, await readOutcomes()).get(id)?.clean,
    ).toBe(1);
  });

  test("ledger contention leaves the next request responsive", async () => {
    await appendMemory({
      type: "learning",
      scope: "fixture",
      content: ROW,
      repo: "global",
    });
    const p = await plugin();
    const sid = "ses-contention";
    const alternate = "ZX_CURSOR_STALLED pager pagination";
    const recent = "MQTT_RETAINED_FRAME broker topic";
    for (const content of [alternate, recent])
      await appendMemory({
        type: "learning",
        scope: "fixture",
        content,
        repo: "global",
      });
    const prior = await read(p, sid, "prior", recent);
    await request(p, sid, "prior", textOf(prior));
    expect(await pullCredits()).toHaveLength(1);
    const event = await read(p, sid, "busy");
    const second = await read(p, sid, "also-busy", alternate);
    const third = await read(p, sid, "throttled", recent);
    for (const [placed, content] of [
      [event, ROW],
      [second, alternate],
      [third, recent],
    ] as const)
      expect(
        textOf(placed)
          .split("\n")
          .filter((line) => line.startsWith("- ["))
          .map((line) => line.endsWith(content)),
      ).toEqual([true]);

    const acquired = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const holding = withStoreLock(hitsFile(), async () => {
      acquired.resolve();
      await gate.promise;
    });
    await acquired.promise;
    try {
      const start = performance.now();
      await request(
        p,
        sid,
        "busy",
        textOf(event),
        {
          id: "also-busy",
          text: textOf(second),
        },
        { id: "throttled", text: textOf(third) },
      );
      expect(performance.now() - start).toBeLessThan(1000);
      expect(await pullCredits()).toHaveLength(1);
      const skipped = ev(readEvidenceLog(), "pull_credit_skipped");
      expect(skipped.map((line) => line.reason)).toEqual([
        "write_failed",
        "budget",
      ]);
      expect(skipped[0]).toMatchObject({
        reason: "write_failed",
        tool: "read",
        rows: "1",
        repoPath: repo,
      });
      expect(skipped[1]).toMatchObject({ rows: "1", repoPath: repo });
      expect(JSON.stringify(skipped)).not.toContain(CUE);
    } finally {
      gate.resolve();
      await holding;
    }
  });

  test("Scenario: a request from another session cannot settle the call", async () => {
    await appendMemory({
      type: "learning",
      scope: "fixture",
      content: ROW,
      repo: "global",
    });
    const p = await plugin();
    const sid = "ses-receipt-owner";
    await p.sessionHooks.prompt({ sessionID: sid, prompt: { text: "go" } });
    const event = await read(p, sid, "call-owned");
    await request(p, "ses-receipt-other", "call-owned", textOf(event));
    expect(await pullCredits()).toEqual([]);
    await request(p, sid, "call-owned", textOf(event));
    expect(await pullCredits()).toHaveLength(1);
  });
});
