// Contract: portability (JSONL export/import) + decay of stale open
// threads. Export is the ACTIVE store (superseded rows excluded); import
// re-enters through the SAME runWriteGate as any other write, so gate
// semantics apply unchanged: ref-free settled rows need session engagement,
// and the tests ground it with a `read` tool result exactly like
// test/capture.test.ts (that is intended behavior, not a workaround). Decay
// defaults to dry-run; a real run snapshots (prune's snapshotFiles helper)
// before any mutation and supersedes rather than deletes. Hermetic: temp
// OPENCODE_MEMORY_DIR / OPENCODE_COMMANDS_DIR.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dateStr, evidenceDir, memoryRoot, snapshotDir } from "../src/config.ts";
import { formatLine, parseLine, type Fields } from "../src/logfmt.ts";
import { resetState } from "../src/state.ts";
import { appendMemory, isActive, loadAll } from "../src/memory.ts";
import type { WriteCandidate } from "../src/gates.ts";
import { exportMemories, findStaleOpen, importMemories } from "../src/portable.ts";
import { setRepoScope } from "../src/repokey.ts";
import { systemDigest } from "../src/inject.ts";
import { loadPlugin } from "./harness.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-portable-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

interface SeedOpts {
  ts?: string;
  status?: "open" | "settled";
  superseded_by?: string;
  tags?: string[];
  issue?: string;
}

// Seed a row directly into the store (tests exercise the engine, not the gate).
function seed(type: string, scope: string, content: string, extra: SeedOpts = {}): string {
  const ts = extra.ts ?? new Date().toISOString();
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    formatLine({
      ts,
      type,
      scope,
      content,
      status: extra.status,
      tags: extra.tags?.join(","),
      issue: extra.issue,
      superseded_by: extra.superseded_by,
      reason: extra.superseded_by ? "update" : undefined,
    }) + "\n",
  );
  return ts;
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

// NOTE: the store's own uniqueness guarantee lives in appendMemory; these
// seeds write directly, so every ts must be made unique explicitly (+msOffset).
const daysAgo = (n: number, msOffset = 0) =>
  new Date(Date.now() - n * 86_400_000 + msOffset).toISOString();

// Ground the session: a recorded code-tool result makes the gate accept
// ref-free settled candidates (behavior-grounded promotion), exactly as for
// model-authored writes — same pattern as test/capture.test.ts.
async function engage(loaded: Awaited<ReturnType<typeof loadPlugin>>, sid: string) {
  await loaded["tool.execute.after"]!(
    { tool: "read", sessionID: sid, callID: "C1", args: { filePath: "x.ts" } },
    { title: "read", output: "content", metadata: {} },
  );
}

// --- exportMemories -------------------------------------------------------------

describe("exportMemories", () => {
  test("exports active rows as JSONL under exports/; superseded rows excluded", async () => {
    const t1 = seed("learning", "build", "Alpha builds run make all from the repository root.", {
      tags: ["ci"],
      issue: "42",
    });
    const t2 = seed("context", "api", "Rate limit is 120 requests per minute per key.", {
      status: "open",
      ts: daysAgo(0, 1),
    });
    seed("pattern", "db", "Retired fact about the old shard layout.", {
      superseded_by: "2026-01-01T00:00:00.000Z",
      ts: daysAgo(1, 2),
    });

    const res = await exportMemories();
    expect(res.count).toBe(2);
    expect(res.path.startsWith(join(memoryRoot(), "exports"))).toBe(true);
    expect(res.path.endsWith(".jsonl")).toBe(true);
    expect(existsSync(res.path)).toBe(true);

    const all = readFileSync(res.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // v1 format: line 0 is the export header that vouches for
    // status="open" rows on import.
    expect(all[0]).toMatchObject({ _export: "opencode-self-improvement", version: 1, count: 2 });
    const rows = all.slice(1);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.ts).sort()).toEqual([t1, t2].sort());
    for (const r of rows) expect("superseded_by" in r).toBe(false);
    const withTags = rows.find((r) => r.ts === t1)!;
    expect(withTags.type).toBe("learning");
    expect(withTags.scope).toBe("build");
    expect(withTags.tags).toEqual(["ci"]);
    expect(withTags.issue).toBe("42");
    const openRow = rows.find((r) => r.ts === t2)!;
    expect(openRow.status).toBe("open");
  });

  test("scope filter and explicit file path are honored", async () => {
    seed("learning", "build", "One durable fact about the build pipeline here.");
    seed("learning", "api", "One durable fact about the api surface lives here.");
    const file = join(root, "out.jsonl");
    const res = await exportMemories({ scope: "api", file });
    expect(res.count).toBe(1);
    expect(res.path).toBe(file);
    const row = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[1]!);
    expect(row.scope).toBe("api");
  });

  test("empty store exports only the header line (file still written)", async () => {
    const res = await exportMemories();
    expect(res.count).toBe(0);
    const text = readFileSync(res.path, "utf8").trim();
    expect(JSON.parse(text)).toMatchObject({ _export: "opencode-self-improvement", count: 0 });
  });
});

// --- importMemories (pure, typed gate callback) -----------------------------------

describe("importMemories", () => {
  test("malformed lines are skipped; valid rows reach the gate; tally by action", async () => {
    const file = join(root, "in.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "learning", scope: "build", content: "A durable build fact." }),
        "this is not json at all",
        JSON.stringify({ type: "wisdom", scope: "build", content: "Unknown type must be skipped." }),
        JSON.stringify({ type: "learning", scope: "", content: "Empty scope must be skipped." }),
        JSON.stringify({ type: "pattern", scope: "api", content: "A durable api fact." }),
      ].join("\n") + "\n",
    );
    const seen: WriteCandidate[] = [];
    const gate = async (c: WriteCandidate) => {
      seen.push(c);
      return { action: seen.length === 1 ? "promoted" : "blocked" };
    };
    const t = await importMemories(file, gate);
    expect(t).toEqual({ promoted: 1, collapsed: 0, blocked: 1, skipped: 3, downgraded: 0 });
    expect(seen.length).toBe(2);
    expect(seen[0].content).toBe("A durable build fact.");
  });

  test("optional fields are sanitized, not fatal; collapsed tallies as collapsed", async () => {
    const file = join(root, "in2.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        type: "learning",
        scope: "build",
        content: "Another durable build fact overall.",
        status: "pending", // invalid -> dropped
        tags: "ci", // not an array -> dropped
        issue: 7, // not a string -> dropped
      }) + "\n",
    );
    let got: WriteCandidate | undefined;
    const t = await importMemories(file, async (c) => {
      got = c;
      return { action: "collapsed" };
    });
    expect(t).toEqual({ promoted: 0, collapsed: 1, blocked: 0, skipped: 0, downgraded: 0 });
    expect(got!.status).toBeUndefined();
    expect(got!.tags).toBeUndefined();
    expect(got!.issue).toBeUndefined();
  });

  test("a missing file throws (the tool turns it into a soft message)", async () => {
    await expect(importMemories(join(root, "nope.jsonl"), async () => ({ action: "promoted" }))).rejects.toThrow(/not found/);
  });
});

// --- frontier policy on import ---------------------------------------------------

describe("import frontier policy", () => {
  const openRow = {
    type: "context",
    scope: "plan",
    content: "Open thread planted to claim the frontier grounding exemption.",
    status: "open",
  };

  test("without an export header, status=open is downgraded to settled and tallied", async () => {
    const file = join(root, "nohdr.jsonl");
    writeFileSync(file, JSON.stringify(openRow) + "\n");
    let got: WriteCandidate | undefined;
    const t = await importMemories(file, async (c) => {
      got = c;
      return { action: "promoted" };
    });
    expect(got!.status).toBe("settled");
    expect(t).toEqual({ promoted: 1, collapsed: 0, blocked: 0, skipped: 0, downgraded: 1 });
  });

  test("with a v1 export header, status=open survives and the header is not tallied", async () => {
    const file = join(root, "hdr.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ _export: "opencode-self-improvement", version: 1, exportedAt: "x", count: 1 }),
        JSON.stringify(openRow),
      ].join("\n") + "\n",
    );
    let got: WriteCandidate | undefined;
    const t = await importMemories(file, async (c) => {
      got = c;
      return { action: "promoted" };
    });
    expect(got!.status).toBe("open");
    expect(t).toEqual({ promoted: 1, collapsed: 0, blocked: 0, skipped: 0, downgraded: 0 });
  });

  test("a header version newer than ours does NOT grant the exemption (fail closed)", async () => {
    const file = join(root, "future.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ _export: "opencode-self-improvement", version: 999 }),
        JSON.stringify(openRow),
      ].join("\n") + "\n",
    );
    let got: WriteCandidate | undefined;
    const t = await importMemories(file, async (c) => {
      got = c;
      return { action: "promoted" };
    });
    expect(got!.status).toBe("settled");
    expect(t.downgraded).toBe(1);
  });

  test("a pasted header cannot grant a repo:global row an open frontier everywhere", async () => {
    const payload = "PLANTED global open thread must not ride an unrelated repo prompt.";
    const file = join(root, "forged-global.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ _export: "opencode-self-improvement", version: 1 }),
        JSON.stringify({ ...openRow, content: payload, repo: "global" }),
      ].join("\n") + "\n",
    );
    setRepoScope({ key: "repo-a", path: join(root, "repo-a") });
    const t = await importMemories(file, async (c) => {
      await appendMemory(c);
      return { action: "promoted" };
    });
    expect(t.downgraded).toBe(1);
    expect((await loadAll()).find((m) => m.content === payload)?.status).toBe("settled");

    setRepoScope({ key: "repo-b", path: join(root, "repo-b") });
    const system: string[] = [];
    await systemDigest({ sessionID: "unrelated-repo" }, { system });
    expect(system.join("\n")).not.toContain(payload);
  });

  test("a foreign 12-hex repo stamp is replaced with the importing repo scope", async () => {
    const payload = "the flimflam widget forged-repo claim lands in the importing repo only";
    const file = join(root, "forged-repo.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ _export: "opencode-self-improvement", version: 1 }),
        JSON.stringify({ ...openRow, content: payload, repo: "5981a5640bc3" }),
      ].join("\n") + "\n",
    );
    const importing = { key: "a1b2c3d4e5f6", path: join(root, "importing-repo") };
    setRepoScope(importing);

    const t = await importMemories(file, async (c) => {
      await appendMemory(c);
      return { action: "promoted" };
    });

    const got = (await loadAll()).find((m) => m.content === payload);
    expect(t).toEqual({ promoted: 1, collapsed: 0, blocked: 0, skipped: 0, downgraded: 0 });
    expect(got?.status).toBe("open");
    expect(got?.repo).toBe(importing.key);
    expect(got?.repoPath).toBe(importing.path);
    expect(got?.repo).not.toBe("5981a5640bc3");
  });

  test("an unverifiable stamped open row is downgraded when the importing session has no scope", async () => {
    const file = join(root, "unscoped-foreign.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ _export: "opencode-self-improvement", version: 1 }),
        JSON.stringify({ ...openRow, repo: "5981a5640bc3", repoPath: "/foreign/repo" }),
      ].join("\n") + "\n",
    );
    setRepoScope(null);
    let got: WriteCandidate | undefined;
    const t = await importMemories(file, async (c) => {
      got = c;
      return { action: "promoted" };
    });

    expect(t.downgraded).toBe(1);
    expect(got?.status).toBe("settled");
    // The stamp is kept: dropping it would widen the row to global.
    expect(got?.repo).toBe("5981a5640bc3");
    expect(got?.repoPath).toBe("/foreign/repo");
  });

  test("an explicit global settled row stays global", async () => {
    const payload = "Settled global convention imported from another machine stays global.";
    const file = join(root, "settled-global.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ _export: "opencode-self-improvement", version: 1 }),
        JSON.stringify({ ...openRow, status: "settled", content: payload, repo: "global" }),
      ].join("\n") + "\n",
    );
    setRepoScope({ key: "a1b2c3d4e5f6", path: join(root, "importing-repo") });
    let got: WriteCandidate | undefined;
    const t = await importMemories(file, async (c) => {
      got = c;
      return { action: "promoted" };
    });

    expect(t.downgraded).toBe(0);
    expect(got?.status).toBe("settled");
    expect(got?.repo).toBe("global");
  });
});

// --- findStaleOpen -----------------------------------------------------------------

describe("findStaleOpen", () => {
  test("only active open rows older than the cutoff, oldest first", async () => {
    seed("context", "a", "Fresh open thread that must not be listed.", { status: "open" });
    const old1 = seed("context", "b", "Old open thread number one from a month ago.", {
      ts: daysAgo(30),
      status: "open",
    });
    const old2 = seed("context", "c", "Older open thread number zero from two months back.", {
      ts: daysAgo(60),
      status: "open",
    });
    seed("learning", "d", "Old settled fact must never decay.", { ts: daysAgo(60, 1) });
    seed("context", "e", "Old superseded open row is already inactive.", {
      ts: daysAgo(60, 2),
      status: "open",
      superseded_by: "2026-01-01T00:00:00.000Z",
    });
    const stale = await findStaleOpen(14);
    expect(stale.map((m) => m.ts)).toEqual([old2, old1]); // oldest first
    expect((await findStaleOpen(90)).length).toBe(0);
  });
});

// --- end-to-end through the plugin tools ---------------------------------------------

describe("memory_export / memory_import tools (round trip)", () => {
  test("export then import into a fresh store: all promoted; second import collapses", async () => {
    seed("learning", "build", "Alpha builds run make all from the repository root directory.");
    seed("pattern", "api", "The staging API rate limit is 120 requests per minute per key.");
    seed("context", "plan", "Open thread: decide the shard key before the migration ships.", {
      status: "open",
    });

    const loaded = await loadPlugin(liveRoot);
    const exp = await loaded.tool.memory_export!.execute({});
    expect(exp).toContain("Exported 3 memories ->");
    const file = exp.split(" -> ")[1]!;
    expect(existsSync(file)).toBe(true);

    // Fresh store (simulates another machine).
    process.env.OPENCODE_MEMORY_DIR = join(root, "memory2");
    await engage(loaded, "ses-imp"); // ground the settled ref-free rows

    const imp = await loaded.tool.memory_import!.execute({ file });
    expect(imp).toContain("3 promoted");
    expect(imp).toContain("0 duplicates collapsed");
    const mems = (await loadAll()).filter(isActive);
    expect(mems.length).toBe(3);
    expect(mems.every((m) => m.tags?.includes("import"))).toBe(true);
    // The open thread kept its status through the round trip.
    expect(mems.filter((m) => m.status === "open").length).toBe(1);

    // Second import of the same file: the gate dedupes every row.
    const imp2 = await loaded.tool.memory_import!.execute({ file });
    expect(imp2).toContain("0 promoted");
    expect(imp2).toContain("3 duplicates collapsed");
    expect((await loadAll()).filter(isActive).length).toBe(3);
  });

  test("malformed lines are skipped and counted; a missing file fails soft", async () => {
    const file = join(root, "mixed.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "learning", scope: "build", content: "Durable fact that should promote fine here." }),
        "{ broken json",
        JSON.stringify({ type: "nope", scope: "x", content: "Unknown type skipped." }),
      ].join("\n") + "\n",
    );
    const loaded = await loadPlugin(liveRoot);
    await engage(loaded, "ses-mix");
    const out = await loaded.tool.memory_import!.execute({ file });
    expect(out).toContain("1 promoted");
    expect(out).toContain("2 malformed lines skipped");

    const missing = await loaded.tool.memory_import!.execute({ file: join(root, "gone.jsonl") });
    expect(missing).toContain("memory_import failed");
    expect(missing).toContain("not found");
  });
});

describe("memory_decay tool", () => {
  const OLD_OPEN = "Old open thread about the storage migration from last month.";
  const FRESH_OPEN = "Fresh open thread about the import UX, started today.";
  const OLD_SETTLED = "Old settled fact about release tagging from last month.";

  function seedThree(): { oldOpen: string; freshOpen: string; oldSettled: string } {
    const oldOpen = seed("context", "plan", OLD_OPEN, { ts: daysAgo(30), status: "open" });
    const freshOpen = seed("context", "plan", FRESH_OPEN, { status: "open", ts: daysAgo(0, 1) });
    const oldSettled = seed("learning", "build", OLD_SETTLED, { ts: daysAgo(30, 1) });
    return { oldOpen, freshOpen, oldSettled };
  }

  test("dry run (the default) lists only the stale open thread and mutates nothing", async () => {
    const { oldOpen, freshOpen, oldSettled } = seedThree();
    const loaded = await loadPlugin(liveRoot);

    const out = await loaded.tool.memory_decay!.execute({});
    expect(out).toContain("Dry run: 1 open thread(s) older than 14 days");
    expect(out).toContain(oldOpen);
    expect(out).not.toContain(freshOpen);
    expect(out).not.toContain(oldSettled);

    // Nothing mutated: all three rows are still active, no snapshot written.
    const mems = await loadAll();
    expect(mems.filter(isActive).length).toBe(3);
    expect(existsSync(snapshotDir())).toBe(false);

    // Evidence: one decay_dry_run line naming the row; no decay_applied.
    const dry = evidence().filter((l) => l.ev === "decay_dry_run");
    expect(dry.length).toBe(1);
    expect(String(dry[0].stale)).toBe("1");
    expect(String(dry[0].mem)).toBe(oldOpen);
    expect(evidence().filter((l) => l.ev === "decay_applied").length).toBe(0);
  });

  test("olderThanDays is honored both ways", async () => {
    seedThree();
    const loaded = await loadPlugin(liveRoot);
    const tooOld = await loaded.tool.memory_decay!.execute({ olderThanDays: 60 });
    expect(tooOld).toContain("No active open threads older than 60 days.");
    const fits = await loaded.tool.memory_decay!.execute({ olderThanDays: 7 });
    expect(fits).toContain("Dry run: 1 open thread(s) older than 7 days");
  });

  test("dryRun=false supersedes the stale open row snapshot-first; settled untouched", async () => {
    const { oldOpen, freshOpen, oldSettled } = seedThree();
    const loaded = await loadPlugin(liveRoot);

    const out = await loaded.tool.memory_decay!.execute({ dryRun: false });
    expect(out).toContain("Decayed 1 open thread(s) older than 14 days");

    const all = await loadAll();
    const decayed = all.find((m) => m.ts === oldOpen)!;
    expect(isActive(decayed)).toBe(false);
    expect(decayed.superseded_by).toBe("decay");
    expect(decayed.reason).toBe("decay");
    // Fresh open and old settled are untouched and still active.
    const fresh = all.find((m) => m.ts === freshOpen)!;
    expect(isActive(fresh)).toBe(true);
    const settled = all.find((m) => m.ts === oldSettled)!;
    expect(isActive(settled)).toBe(true);
    expect(settled.superseded_by).toBeUndefined();

    // Snapshots exist in snapshotDir() (the explicit pre-mutation pass plus
    // markSuperseded's own), named <stamp>-<original file>.
    const snaps = readdirSync(snapshotDir());
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(snaps.some((s) => s.endsWith(`-${oldOpen.split("T")[0]}.logfmt`))).toBe(true);

    // Evidence: one decay_applied line with the tally and the snapshot path.
    const applied = evidence().filter((l) => l.ev === "decay_applied");
    expect(applied.length).toBe(1);
    expect(String(applied[0].retired)).toBe("1");
    expect(String(applied[0].mem)).toBe(oldOpen);
    expect(String(applied[0].snapshot)).toContain(oldOpen.split("T")[0]);

    // Idempotent: a second real run finds nothing left to retire.
    const again = await loaded.tool.memory_decay!.execute({ dryRun: false });
    expect(again).toContain("No active open threads older than 14 days.");
  });
});
