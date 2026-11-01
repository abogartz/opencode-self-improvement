// #177: exercise injection accounting through the registered host hooks and
// public ledger/status surfaces, with the epoch policy inline or extracted.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { hitsFile, readLedger, resetHitThrottle, resetLedgerCache } from "../src/hits/ledger.ts";
import { parseLine } from "../src/core/logfmt/format.ts"
import { readLines } from "../src/core/logfmt/read.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { noteAuthored, resetState } from "../src/core/state.ts";
import { readStatus } from "../src/status/write.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";

const envKeys = [
  "OPENCODE_MEMORY_DIR",
  "OPENCODE_COMMANDS_DIR",
  "OPENCODE_MEMORY_INJECT_BUDGET",
  "OPENCODE_MEMORY_FRONTIER_BUDGET",
] as const;
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
  root = mkdtempSync(join(tmpdir(), "osi-injection-accounting-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  process.env.OPENCODE_MEMORY_INJECT_BUDGET = "1200";
  process.env.OPENCODE_MEMORY_FRONTIER_BUDGET = "3600";
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
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("osi-injection-accounting-")) {
    throw new Error("Unexpected fixture cleanup target");
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const seed = (content: string) =>
  appendMemory({ type: "learning", scope: "rig", content, repo: "global" });

async function plugin(): Promise<LoadedPlugin> {
  const p = await loadPlugin(repo);
  plugins.push(p);
  return p;
}

const prompt = (p: LoadedPlugin, sid: string, text = "azuki calibration") =>
  p.sessionHooks.prompt({ sessionID: sid, prompt: { text } });

async function context(p: LoadedPlugin, sid: string): Promise<string[]> {
  const event = { sessionID: sid, system: [] as { type: string; text: string }[] };
  await p.sessionHooks.context(event);
  return event.system.map((part) => part.text);
}

async function counters(p: LoadedPlugin, sid: string) {
  // The status file flushes at epoch/usage updates, not every context hook.
  // memory_status reads the live counters used by the user-facing report.
  const { content } = await p.tools.memory_status.execute({}, { sessionID: sid, id: "status" });
  const match = content.match(/session\s+(\d+) request\(s\)[^\n]*\babstained (\d+)\b/);
  if (!match) throw new Error(`No session counters in memory_status: ${content}`);
  return { requests: Number(match[1]), abstained: Number(match[2]) };
}

test.each([220, 1200])("injection credits only budget-surviving rows and their shared terms (budget %i)", async (budget) => {
  process.env.OPENCODE_MEMORY_INJECT_BUDGET = String(budget);
  const shortText = "azuki calibration keeps widgets aligned";
  const longText = `azuki calibration excludednote ${"x".repeat(400)}`;
  const short = await seed(shortText);
  const long = await seed(longText);
  await seed("koto deployment uses the release runner");
  const p = await plugin();
  const sid = "ses-accounting-budget";
  const query = "azuki calibration excludednote privatequery";

  await prompt(p, sid, query);
  const system = await context(p, sid);
  const block = system.find((part) => part.startsWith("## Relevant durable memory"));
  expect(block).toBeDefined();
  expect(block).toContain(shortText);
  expect(block?.length).toBeLessThanOrEqual(budget);
  // The wider-budget case proves the long row is eligible; only the budget
  // keeps it out of the narrow case, not a relevance mismatch.
  if (budget === 220) expect(block).not.toContain(longText);
  else expect(block).toContain(longText);
  expect(block).not.toContain("koto deployment");

  const ledger = await readLedger();
  const expectedRows = budget === 220 ? [short] : [short, long];
  expect([...ledger.byRow.keys()].sort()).toEqual(expectedRows.sort());
  for (const row of expectedRows) expect(ledger.byRow.get(row)?.count).toBe(1);
  const entries = (await readLines(hitsFile())).map(parseLine);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ ev: "memory_used", src: "inject", sid });
  expect(entries[0]?.terms).toBe(budget === 220 ? "[azuki,calibration]" : "[azuki,calibration,excludednote]");
  expect((await readLines(hitsFile())).join("\n")).not.toContain("privatequery");
});

test("a discarded self-authored rebuild adds no credit; an adopted rebuild does", async () => {
  const original = await seed("azuki calibration keeps widgets aligned");
  const p = await plugin();
  const sid = "ses-accounting-rebuild";
  await prompt(p, sid);
  const frozen = await context(p, sid);
  expect(frozen.join("\n")).toContain("keeps widgets aligned");
  expect((await readLedger()).byRow.get(original)?.count).toBe(1);
  const before = await readLines(hitsFile());

  // Clearing the writer's throttle means an accidental duplicate call cannot
  // hide behind rate limiting, even when it credits exactly the same rows.
  resetHitThrottle();
  expect(await context(p, sid)).toEqual(frozen);
  expect(await readLines(hitsFile())).toEqual(before);

  const ownText = "azuki calibration uses the blue alignment gauge";
  const own = await seed(ownText);
  noteAuthored(sid, own); // Fixture: this row was promoted by the reading session.
  resetHitThrottle();
  expect(await context(p, sid)).toEqual(frozen);
  expect(await readLines(hitsFile())).toEqual(before);
  expect((await readLedger()).byRow.has(own)).toBe(false);
  expect((await readStatus(sid))?.recomputes).toBe(1);

  // A foreign write must actually adopt the rebuilt block and resume credit.
  // This also proves the discarded row was relevant and fit in the budget.
  const foreignText = "azuki calibration records temperature changes";
  const foreign = await seed(foreignText);
  resetHitThrottle();
  const adopted = await context(p, sid);
  expect(adopted.join("\n")).toContain(ownText);
  expect(adopted.join("\n")).toContain(foreignText);
  const ledger = await readLedger();
  expect(ledger.lines).toBe(2);
  expect(ledger.byRow.get(original)?.count).toBe(2);
  expect(ledger.byRow.get(own)?.count).toBe(1);
  expect(ledger.byRow.get(foreign)?.count).toBe(1);
  expect((await readStatus(sid))?.reason).toBe("store_changed");
  expect((await readStatus(sid))?.recomputes).toBe(2);
});

test("context without an epoch does not count as abstention, before a prompt or after compaction", async () => {
  await seed("azuki calibration keeps widgets aligned");
  const p = await plugin();
  const sid = "ses-accounting-no-epoch";
  expect((await context(p, sid)).join("\n")).not.toContain("## Relevant durable memory");
  expect(await readStatus(sid)).toBeNull();

  // Creating the first epoch makes earlier request counters observable.
  await prompt(p, sid);
  expect(await counters(p, sid)).toEqual({ requests: 1, abstained: 0 });
  expect((await context(p, sid)).join("\n")).toContain("keeps widgets aligned");
  expect(await counters(p, sid)).toEqual({ requests: 2, abstained: 0 });

  await p.sessionHooks.compaction({ sessionID: sid, system: [] });
  expect((await context(p, sid)).join("\n")).not.toContain("## Relevant durable memory");
  await prompt(p, sid);
  expect(await counters(p, sid)).toEqual({ requests: 3, abstained: 0 });
});

test.each([
  { cause: "no vocabulary match", budget: 1200, query: "koto deployment" },
  { cause: "budget excludes every row", budget: 1, query: "azuki calibration" },
])("an empty established epoch counts one abstention per request: $cause", async ({ budget, query }) => {
  process.env.OPENCODE_MEMORY_INJECT_BUDGET = String(budget);
  await seed("azuki calibration keeps widgets aligned");
  const p = await plugin();
  const sid = "ses-accounting-empty";
  await prompt(p, sid, query);
  expect((await readStatus(sid))?.block).toBe("");
  expect(await counters(p, sid)).toEqual({ requests: 0, abstained: 0 });

  for (const requests of [1, 2]) {
    expect((await context(p, sid)).join("\n")).not.toContain("## Relevant durable memory");
    expect(await counters(p, sid)).toEqual({ requests, abstained: requests });
  }
  expect((await readLedger()).lines).toBe(0);
});
