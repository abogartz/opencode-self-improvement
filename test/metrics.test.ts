// #44 — the store's own numbers: what a row costs, how fast the store grows,
// how stale a capture is, and how much of the store never gets retrieved.
// These are reported, never acted on; the tests pin the math and the wording.
import { describe, expect, test } from "bun:test";
import { fmtBytes, fmtMs } from "../src/status/format.ts"
import { captureLag, percentile, rowsPerDay } from "../src/status/metrics.ts";
import { lagSince } from "../src/capture/lag.ts";
import { formatLine } from "../src/core/logfmt/format.ts";

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

describe("store self-metrics (#44)", () => {
  test("percentile is nearest-rank and never invents a number", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([100], 0.95)).toBe(100);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
  });

  test("rowsPerDay counts active days, not calendar days", () => {
    // 3 rows on one day, 1 row on another -> 2 days saw activity.
    const rows = [{ ts: at(1) }, { ts: at(1) }, { ts: at(1) }, { ts: at(3) }];
    expect(rowsPerDay(rows, 30)).toBe(2);
    // Nothing inside the window is not zero growth; it is no evidence.
    expect(rowsPerDay([{ ts: at(90) }], 30)).toBeNull();
    expect(rowsPerDay([], 30)).toBeNull();
  });

  test("rowsPerDay ignores rows older than the window", () => {
    // Three rows across two distinct days inside 30d -> 1.5 per active day.
    // The two 40-day-old rows count as neither growth nor an active day.
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10) + "T12:00:00.000Z";
    const rows = [daysAgo(1), daysAgo(1), daysAgo(2), daysAgo(40), daysAgo(41)];
    expect(rowsPerDay(rows.map((ts) => ({ ts })), 30)).toBe(1.5);
  });

  test("captureLag reads capture_lag evidence inside the window", () => {
    const lines = [
      formatLine({ ev: "capture_lag", ts: at(1), session: "s", lag: 1000, outcome: "candidates" }),
      formatLine({ ev: "capture_lag", ts: at(2), session: "s", lag: 5000, outcome: "candidates" }),
      formatLine({ ev: "capture_lag", ts: at(3), session: "s", lag: 900, outcome: "empty" }),
      // outside the window, and not ours
      formatLine({ ev: "capture_lag", ts: at(60), session: "s", lag: 999_999, outcome: "candidates" }),
      formatLine({ ev: "epoch_recompute", ts: at(1), session: "s", lag: 42 }),
    ];
    const lag = captureLag(lines, 30);
    expect(lag.n).toBe(3);
    expect(lag.p50).toBe(1000);
    expect(lag.p95).toBe(5000);
  });

  test("a capture with no observed message time contributes no lag", () => {
    const lines = [formatLine({ ev: "capture_lag", ts: at(1), session: "s", outcome: "empty" })];
    const lag = captureLag(lines, 30);
    expect(lag.n).toBe(0);
    expect(lag.p50).toBe(0);
  });

  test("lagSince takes the newest timestamp it can parse", () => {
    const now = Date.UTC(2026, 9, 25, 12);
    expect(lagSince([{ time: { updated: now - 5_000 } }, { time: { updated: now - 90_000 } }], now)).toBe(5_000);
    expect(lagSince([{ createdAt: new Date(now - 2_000).toISOString() }], now)).toBe(2_000);
    expect(lagSince([], now)).toBeNull();
    expect(lagSince([{ content: "no timestamp anywhere" }], now)).toBeNull();
    expect(lagSince("not an array", now)).toBeNull();
    // A garbage timestamp must not become "0 ms — instant".
    expect(lagSince([{ createdAt: "yesterday" }], now)).toBeNull();
  });

  test("byte and duration formatting stay readable", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3 MB");
    expect(fmtMs(999)).toBe("999 ms");
    expect(fmtMs(1500)).toBe("1.5 s");
    expect(fmtMs(120_000)).toBe("2 min");
    expect(fmtMs(5_400_000)).toBe("1.5 h");
  });
});
