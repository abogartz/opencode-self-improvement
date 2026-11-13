// BDD: auto-capture as a user of the REAL host experiences it.
//
// Why this file exists. Every other capture test hands the plugin a hand-written
// event envelope and a scripted `session.context`. That is how this feature shipped
// dead: the envelope was fabricated, so tests passed for days while no live session
// ever fired a pass (README, "Auto-capture is experimental"). The questions those
// tests cannot answer are the ones asked here — does a real `opencode run` turn
// produce the turn-end event capture subscribes to, and does the pass then write a
// row through the real gate into the real store?
//
// The model is still scripted: the fake provider speaks the OpenAI-compatible
// protocol, so the turn, the tool execution, the plugin lifecycle, the write gate
// and the store are all real, and only the assistant's text is fixed. That is the
// strongest thing available without an API key, and it is not what the unit tests
// are.
//
// What writing this found, and what fixed it. A/B/A on one script, 12 runs each,
// back to back on 2026-11-13:
//
//   passes started on a real host .............. 12/12  12/12  12/12
//   passes that reached the write gate ......... 12/12   6/12  12/12
//                                          fix  reverted  fix
//
// An earlier sample of the same unfixed code gave 3/12, so the unfixed rate moves
// with machine load. What does not move is that no sample of the unfixed code
// reached 12/12 and two samples of the fixed code did.
//
// `opencode run` disposes the plugin as soon as the turn ends. `captureCleanup`
// used to abort and then drain, and every pass checked the signal after the model
// call and stopped before the next gate run — the #211 contract, correct for the
// teardown it was written for and fatal here, where nobody tears anything down and
// the process simply exits. Between a quarter and three quarters of passes were
// cut even with a fake model that answers instantly; a real model takes seconds. #404 split the signal into two phases: cleanup abandons only a pass that
// has not answered yet, and drains one that has. All four of #211's disposal tests
// still pass unchanged, because a pass parked IN the model call is still abandoned.
//
// A second load-dependent failure, found while stabilising this file for #403 and
// filed separately: the turn-end event can fail to reach the plugin entirely.
// `./e2e/` at --parallel=4 gave 6 passes in 8 runs; the file alone gave 6 in 6. The
// failing runs stop at `tool_result` — no `capture_cost`, no `capture_lag`, nothing
// blocked — so no pass exists to assert anything about, and the log cannot tell a
// disabled capture from a capture that never fired. That is upstream of #403 and
// #404: the availability check and the drain were never reached. `turnUntil-
// CaptureStarts` retries so this file tests the contract it can test, asserts a pass
// starts within four turns so a dead capture still fails, and prints the attempt
// count so the rate stays visible rather than being re-run away.
//
// The byte-exact row assertion below is therefore unconditional, and it is the
// control for that fix, not a guard: with the two-phase drain reverted it failed
// 1 of 4 runs of this file and 6 of 12 runs of the standalone scenario. A race
// cannot be pinned by a real-host test, so the deterministic half lives in
// test/capture-dispose-drain.test.ts, which disposes a pass parked IN the model
// call and a pass that already answered, and gets opposite answers.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  REPO,
  type Fake,
  type Guest,
  makeGuest,
  startFake,
  turn,
} from "./support/harness.ts";

let fake: Fake;
const guests: Guest[] = [];

beforeAll(async () => {
  fake = await startFake();
});
afterEach(() => {
  // KEEP=1 leaves guest dirs behind for debugging the evidence trail.
  if (process.env.KEEP) {
    for (const g of guests.splice(0)) console.log(`[keep] ${g.root}`);
    return;
  }
  for (const g of guests.splice(0))
    rmSync(g.root, { recursive: true, force: true });
});
afterAll(() => fake.stop());

const PROMPT =
  "E2E::cap read pricing.ts and tell me what rate it applies and when, so I can " +
  "write the checkout summary correctly without guessing at the order of operations";

const CANDIDATE = {
  type: "learning",
  scope: "pricing",
  content:
    "TAX_RATE in pricing.ts is 0.08 and applies before discounts, which the checkout summary relies on",
};

/** A guest whose project is a real git repo, so grounding and availability work. */
function gitGuest(options: Record<string, unknown>): Guest {
  const g = makeGuest(fake, REPO, [], options);
  writeFileSync(
    join(g.projDir, "README.md"),
    "# widget\n\nReorder is inclusive: needsReorder returns true at or below reorderPoint.\n",
  );
  writeFileSync(
    join(g.projDir, "pricing.ts"),
    "export const TAX_RATE = 0.08;\n",
  );
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", g.projDir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  };
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.email=e2e@example.invalid",
    "-c",
    "user.name=e2e",
    "commit",
    "-qm",
    "seed",
  );
  guests.push(g);
  return g;
}

/** read → answer → the capture pass's own reply, served on the capture lane. */
function scriptCaptureTurn(g: Guest): void {
  fake.setSteps({
    "E2E::cap": [
      {
        tool_calls: [
          {
            id: "r1",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({
                path: join(g.projDir, "pricing.ts"),
              }),
            },
          },
        ],
      },
      {
        content:
          "TAX_RATE is 0.08 and it applies before discounts, so the checkout summary uses the pre-discount total.",
      },
      { content: JSON.stringify([CANDIDATE]) },
    ],
  });
}

function evidenceLines(g: Guest): string[] {
  const dir = join(g.memoryDir, "evidence");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".logfmt"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean),
    );
}

function storeRows(g: Guest): string[] {
  if (!existsSync(g.memoryDir)) return [];
  return readdirSync(g.memoryDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.logfmt$/.test(f))
    .flatMap((f) =>
      readFileSync(join(g.memoryDir, f), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean),
    );
}

const withEv = (lines: string[], ev: string) =>
  lines.filter((l) => l.includes(`ev=${ev}`));

/**
 * Runs the turn until a capture pass STARTS, up to `attempts`, and returns the
 * evidence and store at that point.
 *
 * Why this exists rather than one turn per test. Measured on 2026-11-13, this
 * file under `--parallel=4`: 6 of 8 runs produced a pass, 2 of 8 produced
 * `tool_result` and then NOTHING — no `capture_cost`, no `capture_lag`, no row.
 * Solo, 6 of 6 produced a pass. The turn-end event that capture subscribes to can
 * fail to reach the plugin before `opencode run` exits, and when that happens
 * there is no pass to assert anything about.
 *
 * That is a real finding (filed separately) and it is upstream of this PR: no
 * trigger event means the availability check, the write gate and the #404 drain
 * were never reached. It must not be reported as a #404 regression, because the
 * next person to see this file will spend their time on the drain. So the retry
 * makes THIS file's claim the one it can actually support — a pass that started
 * survives teardown and writes byte for byte — while the start rate is printed on
 * every run and the `started` assertion below still fails outright if capture is
 * dead rather than merely unlucky.
 */
async function turnUntilCaptureStarts(
  g: Guest,
  attempts = 4,
): Promise<{ ev: string[]; started: number }> {
  let ev: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const run = await turn(fake, g, PROMPT);
    expect(run.exit).toBe(0);
    for (let i = 0; i < 40; i++) {
      ev = evidenceLines(g);
      if (withEv(ev, "capture_cost").length > 0) break;
      await Bun.sleep(100);
    }
    if (withEv(ev, "capture_cost").length > 0) return { ev, started: attempt };
  }
  return { ev, started: 0 };
}

describe("auto-capture on the real host", () => {
  test("a real turn fires a real capture pass", async () => {
    const g = gitGuest({ autoCapture: true, captureModel: "fake/scripted" });
    scriptCaptureTurn(g);
    const { ev, started } = await turnUntilCaptureStarts(g);
    console.log(`[capture-start] test 1: pass started on attempt ${started}`);
    expect(
      started,
      `no capture pass started in 4 real turns — ${withEv(ev, "tool_result").length} tool results and ${withEv(ev, "capture_cost").length} capture triggers, so the turn-end event is not reaching the plugin at all`,
    ).toBeGreaterThan(0);
    // Asserted before the pass's own fields, because a silent option failure looks
    // exactly like "capture ran and found nothing".
    expect(withEv(ev, "plugin_load").at(-1)).toContain("capture=on");
    // The claim no other test makes: a real `opencode run` turn produces the
    // turn-end event, and the pass really starts.
    const cost = withEv(ev, "capture_cost").at(-1) ?? "";
    expect(cost).toContain("trigger=idle");
    expect(cost).toMatch(/prompt_chars=[1-9]/);
  }, 240_000);

  test("the pass survives host teardown and writes the candidate byte for byte", async () => {
    const g = gitGuest({ autoCapture: true, captureModel: "fake/scripted" });
    scriptCaptureTurn(g);
    // Retry covers the START gap documented on `turnUntilCaptureStarts`; everything
    // below runs only once a pass has actually started, which is what this test is
    // about. A pass that started and was then cut by teardown still fails here, and
    // test/capture-dispose-drain.test.ts pins that half deterministically.
    const { started } = await turnUntilCaptureStarts(g);
    console.log(`[capture-start] test 2: pass started on attempt ${started}`);
    expect(
      started,
      `no capture pass started in 4 real turns, so the teardown contract could not be observed at all`,
    ).toBeGreaterThan(0);

    // Bounded wait, not a fixed sleep: the row is written during cleanup, and the
    // host process then exits, so the only unknown is when the files land.
    let rows: string[] = [];
    for (let i = 0; i < 40; i++) {
      rows = storeRows(g).filter((l) => l.includes("auto-capture"));
      if (rows.length > 0) break;
      await Bun.sleep(100);
    }
    const ev = evidenceLines(g);
    expect(rows.length).toBe(1);
    // Byte-for-byte: a pass that stored a paraphrase would still be "one row".
    expect(rows[0]).toContain(CANDIDATE.content);
    // The pass ran to completion, not just to the store: the completion receipt is
    // what distinguishes a surviving pass from a cut one (#404), and the scan line
    // carries the availability fields this PR added.
    expect(withEv(ev, "capture_lag").at(-1)).toContain("outcome=candidates");
    const scan = withEv(ev, "auto_capture_scan").at(-1) ?? "";
    expect(scan).toContain("verdicts=");
    expect(scan).toContain("restatements=");
    expect(scan).toContain("files=");
  }, 240_000);

  test("control: the same turn with the switch off fires nothing and writes nothing", async () => {
    // Without this, the pass above could be attributed to the switch when it is
    // really ambient, and a dead capture would look identical to a disabled one.
    const g = gitGuest({ autoCapture: false });
    scriptCaptureTurn(g);
    const run = await turn(fake, g, PROMPT);
    expect(run.exit).toBe(0);
    await Bun.sleep(2000);
    const ev = evidenceLines(g);
    expect(withEv(ev, "plugin_load").at(-1)).toContain("capture=off");
    expect(withEv(ev, "capture_cost")).toHaveLength(0);
    expect(withEv(ev, "capture_lag")).toHaveLength(0);
    expect(storeRows(g)).toHaveLength(0);
  }, 240_000);
});
