// Contract (#387): the plugin's own model work is billed, and a zero is never
// mistaken for free.
//
// Capture is a separate `generate.text` call made after the turn. It appears in
// no session's usage, so anything reading session numbers reports it as zero —
// which is how it was billed for its whole history. The host gives the plugin no
// receipt either: `ctx.generate` exposes one member, `text`, resolving to
// `{ text }` with no `usage` and no `tokens` (probed against a running host,
// 2026-11-11). So the number here is an ESTIMATE and every surface that shows it
// says so.
//
// Proves: the estimate sums and windows correctly; a malformed line is skipped
// rather than guessed; the line is written with its session id even when the
// reply lands late (the exact race that made a bench read capture as free); the
// report renders the estimate with its caveat and renders a zero with a reason;
// and the session's completion tokens appear only when the host reports them.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLine } from "../src/core/logfmt/format.ts";
import { captureCost } from "../src/status/metrics.ts";
import { renderMemoryReport } from "../src/status/report.ts";
import type { StatusPayload, StoreCounts } from "../src/status/payload.ts";
import { resetState } from "../src/core/state.ts";
import { memoryRoot } from "../src/core/config/paths.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import { loadPlugin } from "./harness.ts";
import { readEvidenceLog as evidence, sleep } from "./helpers/logfmt.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-cost-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  setRepoScope(null);
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

const line = (
  over: Record<string, string | number | undefined> = [] as never,
) =>
  formatLine({
    ts: new Date().toISOString(),
    ev: "capture_cost",
    session: "ses_a",
    trigger: "idle",
    prompt_chars: "1000",
    text_chars: "200",
    est_tokens: "300",
    receipt: "none",
    ...over,
  } as Record<string, string>);

describe("captureCost metric", () => {
  test("sums calls, chars and estimate; counts distinct sessions", () => {
    const c = captureCost([
      line(),
      line({ text_chars: 400, est_tokens: 350 }),
      line({
        session: "ses_b",
        prompt_chars: 2000,
        text_chars: 0,
        est_tokens: 500,
      }),
    ]);
    expect(c.calls).toBe(3);
    expect(c.sessions).toBe(2);
    expect(c.promptChars).toBe(4000);
    expect(c.textChars).toBe(600);
    expect(c.estTokens).toBe(1150);
    // The label is load-bearing: nothing here is a provider receipt.
    expect(c.source).toBe("estimate");
  });

  test("no evidence is zero calls, not an absent number", () => {
    expect(captureCost([]).calls).toBe(0);
    expect(captureCost([]).estTokens).toBe(0);
  });

  test("other events and out-of-window lines are ignored", () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const c = captureCost([
      line({ ev: "capture_lag" }),
      line({ ts: old }),
      line(),
    ]);
    expect(c.calls).toBe(1);
  });

  test("a line without a usable char count is skipped, never guessed as zero-cost", () => {
    const c = captureCost([
      line({ prompt_chars: "abc" }),
      line({ prompt_chars: "" }),
      line(),
    ]);
    expect(c.calls).toBe(1);
    expect(c.promptChars).toBe(1000);
  });

  test("est_tokens is recomputed from chars when a line omits it", () => {
    const withEst = line();
    const withoutEst = withEst.replace(/(^|\s)est_tokens=\S*/, "");
    expect(withoutEst).not.toContain("est_tokens");
    const c = captureCost([withoutEst]);
    expect(c.calls).toBe(1);
    expect(c.estTokens).toBe(300); // (1000 + 200) / 4
  });
});

describe("report rendering", () => {
  const store = (over: Partial<StoreCounts> = {}): StoreCounts => ({
    active: 2,
    superseded: 0,
    open: 0,
    scopes: 1,
    malformed: 0,
    ...over,
  });
  const base = { blocked: [] };

  test("an estimate is labelled as one, never as a billed number", () => {
    const r = renderMemoryReport({
      ...base,
      status: null,
      store: store({
        captureCost: {
          calls: 3,
          sessions: 2,
          promptChars: 14000,
          textChars: 600,
          estTokens: 3650,
          source: "estimate",
        },
      }),
    });
    expect(r).toContain("3650 tok est.");
    expect(r).toContain("estimate, no provider receipt");
    expect(r).toContain("3 calls");
  });

  test("a zero says there was no call, which is not the same claim as free", () => {
    const r = renderMemoryReport({
      ...base,
      status: null,
      store: store({
        captureCost: {
          calls: 0,
          sessions: 0,
          promptChars: 0,
          textChars: 0,
          estTokens: 0,
          source: "estimate",
        },
      }),
    });
    expect(r).toContain("capture 0 tok — no capture call in the window");
  });

  test("an unread cost is absent, not zero", () => {
    const r = renderMemoryReport({ ...base, status: null, store: store({}) });
    expect(r).not.toContain("capture 0 tok");
    expect(r).not.toContain("tok est.");
  });

  const payload = (over: Partial<StatusPayload> = {}): StatusPayload => ({
    at: "2026-11-11T12:00:00.000Z",
    sessionID: "ses_x",
    reason: "first",
    recomputes: 1,
    block:
      "## Relevant durable memory\n- [2026-11-11] context/config: rate is 2150",
    blockChars: 70,
    budget: 1200,
    store: { active: 1, superseded: 0, open: 0, scopes: 1, malformed: 0 },
    stats: {
      requests: 6,
      abstained: 0,
      cumChars: 420,
      epochRequests: 6,
      invalidations: 0,
      lastInvalidation: null,
    },
    ...over,
  });

  test("completion tokens are reported split, so a reasoning-heavy seat is visible", () => {
    const r = renderMemoryReport({
      ...base,
      store: store({}),
      status: payload({
        measured: {
          at: "2026-11-11T12:01:00.000Z",
          input: 4898,
          read: 87799,
          write: 0,
          output: 215,
          reasoning: 4100,
        },
      }),
    });
    expect(r).toContain("what it produced");
    expect(r).toContain("4315 completion tok");
    expect(r).toContain("215 answer");
    expect(r).toContain("4100 reasoning");
  });

  test("a host that reports no completion tokens gets no generation line, not a zero", () => {
    const r = renderMemoryReport({
      ...base,
      store: store({}),
      status: payload({
        measured: {
          at: "2026-11-11T12:01:00.000Z",
          input: 4898,
          read: 87799,
          write: 0,
        },
      }),
    });
    expect(r).not.toContain("what it produced");
  });
});

describe("capture bills its own call end-to-end", () => {
  async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
      await sleep(5);
    }
  }

  test("a reply that lands after the turn is still attributed to its session", async () => {
    const loaded = await loadPlugin(liveRoot, {
      autoCapture: true,
      captureModel: "fake/model",
    });
    // Park the reply: this is the race that billed capture as free. The bench
    // read the meter when `opencode run` exited, and the reply arrived after it.
    let release: () => void = () => {};
    loaded.capture.generate.park = new Promise<void>((r) => {
      release = r;
    });
    loaded.capture.generate.response = JSON.stringify([
      {
        type: "learning",
        scope: "build",
        content:
          "Run the full suite with bun test from the repo root before shipping.",
      },
    ]);
    loaded.capture.context.messages = [
      { role: "user", content: `make the build green ${"detail".repeat(60)}` },
      {
        role: "assistant",
        content: `ran bun test, it passes now ${"detail".repeat(60)}`,
      },
    ];
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-late" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    // The call is in flight: nothing has been billed yet, and that is honest —
    // the receipt is written by the plugin when the reply lands, so a consumer
    // that stops early sees no line rather than a wrong one.
    expect(evidence().some((f) => f.ev === "capture_cost")).toBe(false);

    release();
    await waitFor(() => evidence().some((f) => f.ev === "capture_cost"));
    const row = evidence().find((f) => f.ev === "capture_cost");
    expect(row?.session).toBe("ses-late");
    expect(Number(row?.prompt_chars)).toBeGreaterThan(500);
    expect(Number(row?.text_chars)).toBeGreaterThan(20);
    expect(Number(row?.est_tokens)).toBe(
      Math.ceil((Number(row?.prompt_chars) + Number(row?.text_chars)) / 4),
    );
    // The field that keeps this from ever being quoted as a provider number.
    expect(row?.receipt).toBe("none");
    await loaded.cleanup();
  });

  test("a capture that throws writes no cost line — nothing was generated", async () => {
    const loaded = await loadPlugin(liveRoot, {
      autoCapture: true,
      captureModel: "fake/model",
    });
    loaded.capture.generate.throws = new Error("capture model exploded");
    loaded.capture.context.messages = [
      { role: "user", content: `make the build green ${"detail".repeat(60)}` },
      {
        role: "assistant",
        content: `ran bun test, it passes now ${"detail".repeat(60)}`,
      },
    ];
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-throw" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    await sleep(120);
    expect(evidence().some((f) => f.ev === "capture_cost")).toBe(false);
    await loaded.cleanup();
  });

  test("a pass disposed mid-model-call writes no cost line, because its store is gone", async () => {
    // #211 stops a disposed pass before it touches a store the caller may have
    // removed, and the cost receipt sits after that check on purpose. So this
    // call's tokens go unbilled: the count undercounts by one at teardown. That
    // is asserted rather than assumed, because an unaccounted call is exactly
    // the hole #387 was filed to close — if it ever starts writing, this test
    // is where the trade-off gets renegotiated.
    const loaded = await loadPlugin(liveRoot, {
      autoCapture: true,
      captureModel: "fake/model",
    });
    let release: () => void = () => {};
    loaded.capture.generate.park = new Promise<void>((r) => {
      release = r;
    });
    loaded.capture.generate.response = "[]";
    loaded.capture.context.messages = [
      { role: "user", content: `rebuild the release ${"detail".repeat(60)}` },
    ];
    loaded.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-disposed" },
    });
    await waitFor(() => loaded.capture.generate.calls.length === 1);
    await loaded.cleanup();
    release();
    await sleep(150);
    expect(evidence().some((f) => f.ev === "capture_cost")).toBe(false);
  });
});
