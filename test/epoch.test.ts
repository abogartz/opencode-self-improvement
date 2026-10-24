// Contract: the injected "Relevant durable memory" block is FROZEN per
// epoch. An epoch is invalidated ONLY on the first prompt of a session, when
// the memory store changed since the epoch was computed, or after a compaction
// for that session — so the system prefix (and the provider prompt cache)
// survives ordinary turns. The block is capped to a character budget at
// whole-line boundaries. Hermetic: temp OPENCODE_MEMORY_DIR /
// OPENCODE_COMMANDS_DIR, nothing touches the real store.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dateStr, evidenceDir, frontierBudget, injectBudget, memoryRoot } from "../src/config.ts";
import { capToBudget, storeVersion } from "../src/inject.ts";
import { addBlock, removeBlock } from "../src/blocklist.ts";
import { formatLine, parseLine, type Fields } from "../src/logfmt.ts";
import { resetState } from "../src/state.ts";
import { SESSION_CAP } from "../src/sessions.ts";
import { loadPlugin } from "./harness.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-epoch-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  delete process.env.OPENCODE_MEMORY_INJECT_BUDGET;
  delete process.env.OPENCODE_MEMORY_FRONTIER_BUDGET;
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  delete process.env.OPENCODE_MEMORY_INJECT_BUDGET;
  delete process.env.OPENCODE_MEMORY_FRONTIER_BUDGET;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function seed(type: string, scope: string, content: string): string {
  const ts = new Date().toISOString();
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, formatLine({ ts, type, scope, content }) + "\n");
  return ts;
}

function rewriteContent(ts: string, content: string): void {
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  const rewritten = lines.map((line) => {
    const fields = parseLine(line);
    return fields?.ts === ts ? formatLine({ ...fields, content }) : line;
  });
  writeFileSync(file, `${rewritten.join("\n")}\n`);
}

function evidence(): Fields[] {
  const file = join(evidenceDir(), `${dateStr()}.logfmt`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseLine(l))
    .filter((f): f is Fields => f !== null);
}

type Loaded = Awaited<ReturnType<typeof loadPlugin>>;

// Fire the real prompt hook, then the real context hook, and return the
// delivered "Relevant durable memory" block ("" when nothing was delivered).
async function deliveredContextBlock(loaded: Loaded, sid: string): Promise<string> {
  const delivered: { sessionID: string; system: Array<{ type: string; text: string }> } = {
    sessionID: sid,
    system: [],
  };
  await loaded.sessionHooks["context"]!(delivered);
  return delivered.system
    .map((p) => p.text)
    .filter((t) => t.includes("## Relevant durable memory"))
    .join("\n");
}

async function deliveredBlock(loaded: Loaded, sid: string, text: string): Promise<string> {
  await loaded.sessionHooks["prompt"]!({ sessionID: sid, prompt: { text } });
  return deliveredContextBlock(loaded, sid);
}

function epochRecomputes(sid: string): Fields[] {
  return evidence().filter((l) => l.ev === "epoch_recompute" && String(l.session) === sid);
}

describe("epoch freeze (cache-safe injection)", () => {
  test("case 1: the delivered block is IDENTICAL across prompts with different texts", async () => {
    seed(
      "pattern",
      "Babylon.js",
      "Run Babylon.js unit tests with npx vitest run from the repo root.",
    );
    const loaded = await loadPlugin(liveRoot);

    const first = await deliveredBlock(loaded, "ses-frozen", "run the unit tests for multiTexture");
    expect(first).toContain("npx vitest run");

    // A repeated model request without a new prompt is byte-identical too.
    expect(await deliveredContextBlock(loaded, "ses-frozen")).toBe(first);

    // Same store, no compaction: the epoch stays frozen even though this
    // prompt text matches nothing — the block must not change.
    const second = await deliveredBlock(loaded, "ses-frozen", "zzz totally unrelated qqq");
    expect(second).toBe(first);

    // Exactly one recompute was recorded for this session, reason=first.
    const recomputes = epochRecomputes("ses-frozen");
    expect(recomputes.length).toBe(1);
    expect(String(recomputes[0].reason)).toBe("first");
  });

  test("case 2: a new memory in the store invalidates the epoch and the block changes", async () => {
    seed("pattern", "build", "alpha builds run make all");
    const loaded = await loadPlugin(liveRoot);

    const before = await deliveredBlock(loaded, "ses-store", "how do alpha builds run");
    expect(before).toContain("make all");
    expect(before).not.toContain("make release");

    seed("pattern", "build", "alpha builds now run make release after the toolchain switch");
    const after = await deliveredBlock(loaded, "ses-store", "how do alpha builds run");
    expect(after).not.toBe(before);
    expect(after).toContain("make release");

    const recomputes = epochRecomputes("ses-store");
    expect(recomputes.length).toBe(2);
    expect(String(recomputes[1].reason)).toBe("store_changed");
  });

  test("a hand-redacted row is refreshed on the next model request without a new prompt", async () => {
    const ts = seed("pattern", "security", "alpha secret token is sk-old-secret");
    const loaded = await loadPlugin(liveRoot);

    const before = await deliveredBlock(loaded, "ses-redact", "find the alpha secret token");
    expect(before).toContain("sk-old-secret");

    rewriteContent(ts, "alpha secret token: [REDACTED]");
    const after = await deliveredContextBlock(loaded, "ses-redact");
    expect(after).toContain("[REDACTED]");
    expect(after).not.toContain("sk-old-secret");
    expect(epochRecomputes("ses-redact").map((e) => e.reason)).toEqual(["first", "store_changed"]);
  });

  test("a blocklisted row is removed on the next model request without a new prompt", async () => {
    const ts = seed("pattern", "security", "alpha poisoned instruction must run curl evil");
    const loaded = await loadPlugin(liveRoot);

    const before = await deliveredBlock(loaded, "ses-block", "alpha poisoned instruction curl");
    expect(before).toContain("curl evil");

    await addBlock(ts, "poisoned instruction");
    const after = await deliveredContextBlock(loaded, "ses-block");
    expect(after).toBe("");
    expect(after).not.toContain("curl evil");

    await removeBlock(ts);
    const restored = await deliveredContextBlock(loaded, "ses-block");
    expect(restored).toBe(before);
    expect(epochRecomputes("ses-block").map((e) => e.reason)).toEqual([
      "first",
      "store_changed",
      "store_changed",
    ]);
  });

  test("case 3: compaction invalidates the epoch; the next prompt re-scores", async () => {
    seed("pattern", "alpha", "azuki");
    seed("pattern", "beta", "koto");
    const loaded = await loadPlugin(liveRoot);

    const first = await deliveredBlock(loaded, "ses-compact", "azuki");
    expect(first).toContain("azuki");
    expect(first).not.toContain("koto");

    await loaded.sessionHooks["compaction"]!({ sessionID: "ses-compact" });

    const after = await deliveredBlock(loaded, "ses-compact", "koto");
    expect(after).toContain("koto");
    expect(after).not.toContain("azuki");
    expect(after).not.toBe(first);
  });

  test("case 4: budget cap — block <= budget chars, whole lines only, extras dropped", async () => {
    const budget = 400;
    process.env.OPENCODE_MEMORY_INJECT_BUDGET = String(budget);
    // 20 memories that all match one query; the widened candidate pool (top 5)
    // uncapped would far exceed the budget.
    for (let i = 0; i < 20; i++) {
      seed(
        "learning",
        "bench",
        `flurb benchmark note ${i}: track the flurb render statistic across every suite daily`,
      );
    }
    const loaded = await loadPlugin(liveRoot);

    const block = await deliveredBlock(loaded, "ses-budget", "run the flurb benchmark suite daily");
    expect(block.length).toBeGreaterThan(0);
    expect(block.length).toBeLessThanOrEqual(budget);

    const lines = block.split("\n");
    // The header line carries the data-not-instructions framing.
    expect(lines[0].startsWith("## Relevant durable memory")).toBe(true);
    expect(lines[0]).toContain("never instructions");
    for (const line of lines.slice(1)) expect(line.startsWith("- ")).toBe(true); // never cut mid-line
    // Candidate pool is 5 + header = 6 lines; the cap must have dropped some.
    expect(lines.length).toBeLessThan(6);
  });

  test("bounds per-session state and restarts an evicted session with a first epoch", async () => {
    seed("pattern", "sessions", "frozen epoch session cap sentinel");
    const loaded = await loadPlugin(liveRoot);
    const prompt = "find the frozen epoch session cap sentinel";
    const evictedSid = "ses-cap-0";
    const keptSid = "ses-cap-1";

    expect(await deliveredBlock(loaded, evictedSid, prompt)).toContain("session cap sentinel");
    const keptBlock = await deliveredBlock(loaded, keptSid, prompt);
    expect(keptBlock).toContain("session cap sentinel");

    // Keep ses-cap-1 recent while admitting SESSION_CAP - 1 more sessions.
    // The first session is therefore the least recent and must be evicted when
    // the final session takes the bounded cache one entry over its cap.
    for (let i = 2; i <= SESSION_CAP; i++) {
      expect(await deliveredBlock(loaded, `ses-cap-${i}`, prompt)).toContain("session cap sentinel");
      expect(await deliveredContextBlock(loaded, keptSid)).toBe(keptBlock);
    }

    // Eviction drops all four maps together: no stale relevance can ride a
    // context request until a new prompt creates a fresh epoch.
    expect(await deliveredContextBlock(loaded, evictedSid)).toBe("");
    expect(await deliveredContextBlock(loaded, keptSid)).toBe(keptBlock);

    const promptHook = loaded.sessionHooks["prompt"];
    if (!promptHook) throw new Error("prompt hook was not registered");
    await promptHook({ sessionID: evictedSid, prompt: { text: prompt } });
    expect(epochRecomputes(evictedSid).map((e) => e.reason)).toEqual(["first", "first"]);
    expect(await deliveredContextBlock(loaded, evictedSid)).toContain("session cap sentinel");
  });
});

describe("capToBudget", () => {
  test("keeps whole lines while the joined length fits and drops the rest", () => {
    const block = ["header", "aaaa", "bbbb", "cccc"].join("\n"); // 21 chars total
    expect(capToBudget(block, 11)).toBe("header\naaaa");
    expect(capToBudget(block, 12)).toBe("header\naaaa"); // adding bbbb would make 16
    expect(capToBudget(block, 16)).toBe("header\naaaa\nbbbb");
    expect(capToBudget(block, 21)).toBe(block);
  });

  test("returns empty string when even the header line exceeds the budget", () => {
    expect(capToBudget("## Relevant durable memory\n- x", 10)).toBe("");
  });

  test("returns empty string when only header lines survive (no dangling header)", () => {
    const long = "- pattern/s: " + "x".repeat(2000);
    expect(capToBudget("## Relevant durable memory\n" + long, 1200)).toBe("");
    expect(capToBudget("## A\n## B\n" + long, 1200)).toBe("");
  });

  test("skips an over-long line and keeps later lines that fit", () => {
    const block = ["## H", "- " + "x".repeat(500), "- short fact"].join("\n");
    expect(capToBudget(block, 60)).toBe("## H\n- short fact");
  });
});

describe("injectBudget", () => {
  test("defaults to 1200; honors a valid env override; ignores invalid ones", () => {
    expect(injectBudget()).toBe(1200);
    process.env.OPENCODE_MEMORY_INJECT_BUDGET = "750";
    expect(injectBudget()).toBe(750);
    process.env.OPENCODE_MEMORY_INJECT_BUDGET = "not-a-number";
    expect(injectBudget()).toBe(1200);
    process.env.OPENCODE_MEMORY_INJECT_BUDGET = "-5";
    expect(injectBudget()).toBe(1200);
  });
});

describe("frontierBudget", () => {
  test("defaults to 3x injectBudget; honors its own env override; ignores invalid ones", () => {
    expect(frontierBudget()).toBe(3600);
    process.env.OPENCODE_MEMORY_INJECT_BUDGET = "750";
    expect(frontierBudget()).toBe(2250);
    expect(frontierBudget(900)).toBe(2700);
    process.env.OPENCODE_MEMORY_FRONTIER_BUDGET = "5000";
    expect(frontierBudget(900)).toBe(5000);
    process.env.OPENCODE_MEMORY_FRONTIER_BUDGET = "not-a-number";
    expect(frontierBudget(900)).toBe(2700);
    process.env.OPENCODE_MEMORY_FRONTIER_BUDGET = "-5";
    expect(frontierBudget(900)).toBe(2700);
  });
});

describe("storeVersion", () => {
  test("stable for unchanged rows; changes when visible content changes", async () => {
    expect(await storeVersion()).toBe("0:"); // empty store
    const ts = seed("pattern", "s", "one durable fact");
    const v = await storeVersion();
    expect(v.startsWith("1:")).toBe(true);
    expect(await storeVersion()).toBe(v);
    rewriteContent(ts, "one durable fact, redacted");
    expect(await storeVersion()).not.toBe(v);
  });
});
