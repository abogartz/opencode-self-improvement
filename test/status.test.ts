// The status hand-off: server epoch + per-session ledger + measured usage ->
// status/<sessionID>.json (+ global latest) -> surfaces (memory_status tool;
// the /memory TUI panel reads the same files). Also /memory-report command
// install parity.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dateStr, evidenceDir, memoryRoot } from "../src/config.ts";
import { formatLine } from "../src/logfmt.ts";
import { appendMemory } from "../src/memory.ts";
import {
  blockedRecent,
  cacheHealth,
  cacheRate,
  contextLines,
  estTok,
  fmtCount,
  readStatus,
  renderMemoryReport,
  sessionStatusFile,
  statusDir,
  statusFile,
  writeStatus,
  type StatusPayload,
} from "../src/status.ts";
import { setRepoScope } from "../src/repokey.ts";
import { loadPlugin } from "./harness.ts";
import { resetState } from "../src/state.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-status-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(memoryRoot(), { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const payload = (over: Partial<StatusPayload> = {}): StatusPayload => ({
  at: "2026-10-20T12:00:00.000Z",
  sessionID: "ses_x",
  reason: "first",
  recomputes: 1,
  block: "## Relevant durable memory\n- [2026-10-20] pattern/build: run bun test",
  blockChars: 70,
  budget: 1200,
  store: { active: 3, superseded: 1, open: 1, scopes: 2, malformed: 0 },
  stats: {
    requests: 14,
    abstained: 3,
    cumChars: 11400,
    epochRequests: 11,
    invalidations: 1,
    lastInvalidation: { at: "2026-10-20T11:47:00.000Z", reason: "store_changed" },
  },
  measured: { at: "2026-10-20T11:58:00.000Z", input: 300, read: 41200, write: 1400 },
  ...over,
});

describe("status files", () => {
  test("round-trip write/read (global latest + per-session)", async () => {
    await writeStatus(payload());
    const got = await readStatus();
    expect(got?.blockChars).toBe(70);
    expect(got?.store.active).toBe(3);
    expect(statusFile()).toContain("status.json");
    expect(await readStatus("ses_x")).not.toBeNull();
    expect(sessionStatusFile("ses_x")).toContain("ses_x.json");
  });

  test("missing or corrupt file reads as null (never throws)", async () => {
    expect(await readStatus()).toBeNull();
    await Bun.write(statusFile(), "{ not json");
    expect(await readStatus()).toBeNull();
    await Bun.write(statusFile(), JSON.stringify({ junk: true }));
    expect(await readStatus()).toBeNull();
  });

  test("a session with no file gets null — never another session's epoch", async () => {
    await writeStatus(payload());
    expect(await readStatus("ses_different")).toBeNull();
  });

  test("write failure is swallowed (surfaces degrade, injection survives)", async () => {
    // memory root is a FILE -> every write under it fails
    delete process.env.OPENCODE_MEMORY_DIR;
    process.env.OPENCODE_MEMORY_DIR = join(root, "a-file");
    writeFileSync(join(root, "a-file"), "blocked");
    await writeStatus(payload()); // must not throw
  });

  test("LRU cap prunes the oldest per-session files", async () => {
    for (let i = 0; i < 35; i++) {
      await writeStatus(payload({ sessionID: `ses_${i}` }));
      await Bun.sleep(2); // distinct mtimes so the prune order is deterministic
    }
    const files = (await readdir(statusDir())).filter((n) => n.endsWith(".json"));
    expect(files.length).toBe(32);
    expect(await readStatus("ses_34")).not.toBeNull(); // newest survives
    expect(await readStatus("ses_0")).toBeNull(); // oldest pruned
  });
});

describe("blockedRecent", () => {
  test("filters to write_blocked, newest-first, respects limit", async () => {
    seedEvidence(dateStr(), [
      { ts: "2026-10-20T10:00:00.000Z", sid: "s1", reason: "ambiguous_memory" },
      { ts: "2026-10-20T10:01:00.000Z", sid: "s1", reason: "ok", noise: true },
      { ts: "2026-10-20T10:02:00.000Z", sid: "s2", reason: "ref_path_missing" },
    ]);
    const rows = await blockedRecent(5);
    expect(rows.length).toBe(2);
    expect(rows[0]!.reason).toBe("ref_path_missing"); // newest first
    expect(rows[1]!.reason).toBe("ambiguous_memory");
  });

  test("includes yesterday and caps at limit", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0]!;
    seedEvidence(yesterday, [{ ts: `${yesterday}T09:00:00.000Z`, sid: "s1", reason: "superseded_overlap" }]);
    seedEvidence(dateStr(), [
      { ts: "2026-10-20T10:00:00.000Z", sid: "s1", reason: "a" },
      { ts: "2026-10-20T10:01:00.000Z", sid: "s1", reason: "b" },
    ]);
    const rows = await blockedRecent(2);
    expect(rows.map((r) => r.reason)).toEqual(["b", "a"]);
    const all = await blockedRecent(9);
    expect(all.length).toBe(3);
    expect(all[2]!.reason).toBe("superseded_overlap");
  });
});

describe("cache math", () => {
  test("cacheRate: reads over total prompt tokens; null when nothing measured", () => {
    const r = cacheRate({ at: "x", input: 300, read: 41200, write: 1400 });
    expect(r?.prompt).toBe(42900);
    expect(r?.pct).toBe(96);
    expect(cacheRate(null)).toBeNull();
    expect(cacheRate({ at: "x", input: 0, read: 0, write: 0 })).toBeNull(); // never 0% for no data
  });

  test("estTok is an estimate, fmtCount compresses only >=10k", () => {
    expect(estTok(812)).toBe(203);
    expect(fmtCount(9999)).toBe("9999");
    expect(fmtCount(11400)).toBe("11.4k");
    expect(fmtCount(41234)).toBe("41.2k");
  });

  test("cacheHealth: dot rules — recent invalidation outranks the last rate", () => {
    expect(cacheHealth(payload())).toBe("green"); // 96%, invalidation BEFORE last measurement
    expect(cacheHealth(payload({ measured: null }))).toBe("recent"); // busted, not yet re-warmed
    expect(
      cacheHealth(
        payload({
          stats: {
            ...payload().stats!,
            invalidations: 2,
            lastInvalidation: { at: "2026-10-20T12:30:00.000Z", reason: "store_changed" },
          },
        }),
      ),
    ).toBe("recent"); // invalidation after the last measurement outranks a 96% rate
    const noInv = { ...payload().stats!, invalidations: 0, lastInvalidation: null };
    expect(cacheHealth(payload({ stats: noInv, measured: { at: "x", input: 400, read: 600, write: 100 } }))).toBe(
      "amber",
    ); // 55%
    expect(cacheHealth(payload({ stats: noInv, measured: { at: "x", input: 24000, read: 100, write: 0 } }))).toBe(
      "red",
    ); // 0%
  });

  test("cacheHealth unknown: nothing measured, no invalidation", () => {
    expect(
      cacheHealth(payload({ stats: { ...payload().stats!, invalidations: 0, lastInvalidation: null }, measured: null })),
    ).toBe("unknown");
  });
});

describe("renderMemoryReport", () => {
  test("no epoch: says so plainly", () => {
    const text = renderMemoryReport({ status: null, store: payload().store, blocked: [] });
    expect(text).toContain("no epoch yet");
    expect(text).toContain("MEMORY STATUS");
  });

  test("epoch: CONTEXT + CACHE receipts + verbatim block", () => {
    const text = renderMemoryReport({ status: payload(), store: payload().store, blocked: [] });
    expect(text).toContain("run bun test");
    expect(text).toContain("INJECTED BLOCK (verbatim)");
    expect(text).toContain("CONTEXT");
    expect(text).toContain("70c ≈ 18 tok · 6% of 1200c budget");
    expect(text).toContain("rode 11 request(s)");
    expect(text).toContain("14 request(s) · 11.4kc ≈ 2850 tok rode · abstained 3");
    expect(text).toContain("CACHE");
    expect(text).toContain("cache busts    1 this session");
    expect(text).toContain("1 block builds since server start (all sessions)");
    expect(text).toContain("41.2k/42.9k prompt tok served from cache (96%)");
    expect(text).toContain("3 active · 1 superseded · 1 open · 2 scopes");
  });

  test("abstention is explained, not shown as empty silence", () => {
    const text = renderMemoryReport({ status: payload({ block: "", blockChars: 0 }), store: payload().store, blocked: [] });
    expect(text).toContain("abstained");
  });

  test("no measurement yet says so, never 0%", () => {
    const text = renderMemoryReport({ status: payload({ measured: null }), store: payload().store, blocked: [] });
    expect(text).toContain("provider reports no cache usage yet");
    expect(text).toContain("structural proof");
    expect(text).not.toContain("served from cache (0%)");
  });

  test("pre-v2 payloads without stats/measured still render", () => {
    const bare = payload();
    delete (bare as Partial<StatusPayload>).stats;
    delete (bare as Partial<StatusPayload>).measured;
    const text = renderMemoryReport({ status: bare, store: bare.store, blocked: [] });
    expect(text).toContain("0 request(s)");
    expect(text).toContain("provider reports no cache usage yet");
  });

  test("blocked rows render with reasons", () => {
    const text = renderMemoryReport({
      status: null,
      store: payload().store,
      blocked: [{ ts: "2026-10-20T10:02:00.000Z", sid: "s2", reason: "ref_path_missing" }],
    });
    expect(text).toContain("ref_path_missing");
  });
});

function seedEvidence(day: string, rows: { ts: string; sid: string; reason: string; noise?: boolean }[]) {
  mkdirSync(evidenceDir(), { recursive: true });
  const lines = rows.map((r) =>
    formatLine(
      r.noise
        ? { ev: "write_promoted", ts: r.ts, sid: r.sid }
        : { ev: "write_blocked", ts: r.ts, sid: r.sid, gate: 4, reason: r.reason, chain: "c" },
    ),
  );
  writeFileSync(join(evidenceDir(), `${day}.logfmt`), lines.join("\n") + "\n");
}

async function poll<T>(fn: () => Promise<T | null>, tries = 100): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(10);
  }
  return null;
}

describe("memory_status tool + epoch wiring", () => {
  test("fresh process: reports no epoch; a prompt creates the epoch AND status.json", async () => {
    const p = await loadPlugin(process.cwd());
    const first = await p.tools.memory_status!.execute({});
    expect(first.content).toContain("no epoch yet");

    await appendMemory({
      type: "pattern",
      scope: "build",
      content: "run bun test from the repo root to execute the suite",
      status: "settled",
    });
    // Drive the real prompt hook: this is what recomputes the frozen epoch.
    await p.sessionHooks["prompt"]!({ sessionID: "ses_status", prompt: { text: "how do I run bun test" } });

    // per-session hand-off exists with the injected block
    const s = await readStatus("ses_status");
    expect(s?.sessionID).toBe("ses_status");
    expect(s?.block).toContain("run bun test");
    expect(s?.recomputes).toBeGreaterThanOrEqual(1);

    // second prompt with unchanged store: NO recompute (cache-safe epoch)
    const before = (await readStatus())!.recomputes;
    await p.sessionHooks["prompt"]!({ sessionID: "ses_status", prompt: { text: "and again" } });
    expect((await readStatus())!.recomputes).toBe(before);
  });

  test("injections count at the decision; message.updated lands measured + flush", async () => {
    const p = await loadPlugin(process.cwd());
    await appendMemory({
      type: "pattern",
      scope: "build",
      content: "run bun test from the repo root to execute the suite",
      status: "settled",
    });
    await p.sessionHooks["prompt"]!({ sessionID: "ses_m", prompt: { text: "how do I run bun test" } });
    // Two provider requests through the injection decision.
    await p["experimental.chat.system.transform"]({ sessionID: "ses_m" }, { system: [] });
    await p["experimental.chat.system.transform"]({ sessionID: "ses_m" }, { system: [] });
    // Measured usage arrives on the event bus (measured listener is default-on).
    p.capture.events.push({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          role: "assistant",
          sessionID: "ses_m",
          tokens: { input: 300, output: 50, reasoning: 0, cache: { read: 41200, write: 1400 } },
        },
      },
    });
    const s = await poll(() => readStatus("ses_m").then((r) => (r?.measured ? r : null)));
    expect(s?.measured?.read).toBe(41200);
    expect(s?.stats?.requests).toBe(2);
    expect(s?.stats?.cumChars).toBeGreaterThan(0);
    expect(s?.stats?.epochRequests).toBe(2);

    // The tool (in-process truth) renders the same receipts for this session.
    await p["tool.execute.before"]({ sessionID: "ses_m", callID: "C1", tool: "memory_status" });
    const rep = await p.tools.memory_status!.execute({});
    expect(rep.content).toContain("41.2k/42.9k prompt tok served from cache (96%)");
    expect(rep.content).toContain("2 request(s)");

    p.capture.events.close();
    await p.cleanup();
  });

  test("2.x message.updated data envelope lands measured usage", async () => {
    const p = await loadPlugin(process.cwd());
    await appendMemory({
      type: "pattern",
      scope: "build",
      content: "run bun test from the repo root to execute the suite",
      status: "settled",
    });
    const promptHook = p.sessionHooks.prompt;
    if (!promptHook) throw new Error("prompt hook not registered");
    await promptHook({ sessionID: "ses_data", prompt: { text: "how do I run bun test" } });
    p.capture.events.push({
      type: "message.updated",
      data: {
        info: {
          id: "msg_data",
          role: "assistant",
          sessionID: "ses_data",
          tokens: { input: 250, output: 40, reasoning: 0, cache: { read: 9000, write: 750 } },
        },
      },
    });

    const s = await poll(() => readStatus("ses_data").then((r) => (r?.measured ? r : null)));
    expect(s?.measured).toEqual(expect.objectContaining({ input: 250, read: 9000, write: 750 }));
    await p.cleanup();
  });

  test("a non-assistant message.updated is ignored", async () => {
    const p = await loadPlugin(process.cwd());
    await appendMemory({
      type: "pattern",
      scope: "build",
      content: "run bun test from the repo root to execute the suite",
      status: "settled",
    });
    await p.sessionHooks["prompt"]!({ sessionID: "ses_u", prompt: { text: "how do I run bun test" } });
    p.capture.events.push({
      type: "message.updated",
      properties: { info: { id: "msg_u", role: "user", sessionID: "ses_u" } },
    });
    await Bun.sleep(60);
    const s = await readStatus("ses_u");
    expect(s?.measured ?? null).toBeNull();
    await p.cleanup();
  });

  test("/memory-report command installs beside /repo-init", async () => {
    await loadPlugin(process.cwd());
    const text = readFileSync(join(process.env.OPENCODE_COMMANDS_DIR!, "memory-report.md"), "utf8");
    expect(text).toContain("memory_status");
  });
});
