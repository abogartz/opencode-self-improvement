// Write-time retrieval keywords (#40 item 3) and the recency tie-break (#40
// item 2).
//
// Keywords are the vocabulary bridge for the bench's strict-paraphrase wall:
// the user's words are not the memory's words, so the row carries its own
// aliases. They are indexed and never rendered — the whole design rests on
// that split, so half of these tests pin the OTHER half: a keyword must never
// reach the model's context, cost a character, or forge a line.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import { appendMemory } from "../src/store/files/append.ts"
import { loadAll } from "../src/store/files/load.ts"
import { MAX_KEYWORDS, MAX_KEYWORD_CHARS, normalizeKeywords } from "../src/store/model/memory.ts";
import { formatMemory } from "../src/inject/format.ts"
import { relevantKnowledge } from "../src/recall/relevant.ts"
import { scoreMemories } from "../src/recall/score.ts";
import { runWriteGate } from "../src/gate/gate.ts";
import { exportMemories } from "../src/portable/export.ts"
import { importMemories } from "../src/portable/import.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import type { Memory } from "../src/store/model/memory.ts";
import { loadPlugin } from "./harness.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-kw-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
});

afterEach(() => {
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const dayFile = () => join(memoryRoot(), `${new Date().toISOString().split("T")[0]}.logfmt`);

function seedAt(ts: string, type: string, scope: string, content: string, extra: Record<string, unknown> = {}): void {
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, formatLine({ ts, type, scope, content, ...extra }) + "\n");
}

// --- the store keeps them -------------------------------------------------------

describe("keywords in the store", () => {
  test("a row's keywords round-trip through disk", async () => {
    await appendMemory({
      type: "pattern",
      scope: "deploys",
      content: "staging deploys run make deploy-staging after the vpn is up",
      kw: ["ship to staging", "promote", "release checklist"],
    });
    const [row] = await loadAll();
    expect(row?.kw).toEqual(["ship to staging", "promote", "release checklist"]);
    expect(readFileSync(dayFile(), "utf8")).toContain("kw=");
  });

  test("normalisation: lowercased, trimmed, de-duped, capped — junk dropped, never a throw", () => {
    const messy = [
      "  Docker Compose  ",
      "docker compose", // duplicate after trim+lowercase
      "",
      42,
      null,
      "x".repeat(MAX_KEYWORD_CHARS + 1), // too long
      ...Array.from({ length: 12 }, (_, i) => `alias ${i}`),
    ] as unknown as string[];
    const out = normalizeKeywords(messy)!;
    expect(out[0]).toBe("docker compose");
    expect(out.filter((k) => k.startsWith("alias"))).toHaveLength(MAX_KEYWORDS - 1);
    expect(out).toHaveLength(MAX_KEYWORDS);
    expect(out.every((k) => k.length <= MAX_KEYWORD_CHARS)).toBe(true);
    expect(normalizeKeywords([])).toBeUndefined();
    expect(normalizeKeywords("not-an-array")).toBeUndefined();
    expect(normalizeKeywords(undefined)).toBeUndefined();
  });

  test("commas are the storage delimiter, not keyword content", async () => {
    // kw serialises as one comma-joined scalar, so an item carrying a comma
    // used to read back fragmented (["build, test"] -> ["build", " test"]).
    expect(normalizeKeywords(["build, test", ",,", "solo,"])).toEqual(["build", "test", "solo"]);
    await appendMemory({
      type: "pattern",
      scope: "deploys",
      content: "deploy happens after the change approval clears",
      kw: ["build, test"],
    });
    const [row] = await loadAll();
    expect(row?.kw).toEqual(["build", "test"]);
  });

  test("a legacy row whose kw field was written fragmented reads back trimmed", async () => {
    // Rows written before the delimiter fix can already sit on disk holding
    // `kw=a, b`; the leading space must not survive into a scoring alias.
    seedAt("2026-02-01T00:00:00.000Z", "learning", "deploys", "legacy row with fragmented keywords", { kw: "a, b" });
    const [row] = await loadAll();
    expect(row?.kw).toEqual(["a", "b"]);
  });

  test("the absolute floor rejects control characters and credential-shaped keywords", async () => {
    await expect(
      appendMemory({ type: "learning", scope: "s", content: "row with a forged keyword line", kw: ["ok", "two\nlines"] }),
    ).rejects.toThrow(/keywords must not contain control characters/);
    await expect(
      appendMemory({
        type: "learning",
        scope: "s",
        content: "row with a secret hiding in its keywords",
        kw: ["ghp_" + "a".repeat(24)],
      }),
    ).rejects.toThrow(/credential-shaped value in: kw/);
    expect(await loadAll()).toHaveLength(0);
  });

  test("the gate rejects malformed keywords the same way it rejects malformed tags", async () => {
    const out = await runWriteGate(
      { type: "learning", scope: "s", content: "a grounded fact about the build pipeline here", kw: "not-an-array" as unknown as string[] },
      { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true },
    );
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("invalid_metadata");
    expect(await loadAll()).toHaveLength(0);
  });

  test("keywords survive export -> import, and they never change the dedup verdict", async () => {
    const content = "restore a dropped column with point-in-time recovery using wal-g";
    const first = await runWriteGate(
      { type: "pattern", scope: "db", content, kw: ["undelete column", "pitr", "backup restore"] },
      { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true },
    );
    expect(first.action).toBe("promoted");

    const exp = await exportMemories({});
    const text = readFileSync(exp.path, "utf8");
    expect(text).toContain('"kw":["undelete column","pitr","backup restore"]');

    // Re-importing the same prose with DIFFERENT keywords still collapses:
    // keywords widen the index, they are not the row's identity.
    const refile = join(memoryRoot(), "restated.jsonl");
    await Bun.write(
      refile,
      [
        JSON.stringify({ _export: "opencode-self-improvement", version: 1, exportedAt: new Date().toISOString(), count: 1 }),
        JSON.stringify({ type: "pattern", scope: "db", content, kw: ["totally other alias"] }),
      ].join("\n") + "\n",
    );
    const tally = await importMemories(refile, (c) =>
      runWriteGate(c, { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true }),
    );
    expect(tally.collapsed).toBe(1);
    const rows = await loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kw).toEqual(["undelete column", "pitr", "backup restore"]);
  });
});

// --- they are indexed, never shown ----------------------------------------------

describe("keywords in retrieval", () => {
  // The bridge, isolated: same row, same query, only the index differs.
  const CONTENT = "the ledger dashboard re-renders on every websocket frame unless selectors memoize";
  const QUERY = "why is my dashboard so slow with live updates";

  test("a row with no keywords abstains on the paraphrase; the same row with keywords answers", async () => {
    seedAt("2026-04-01T00:00:00.000Z", "learning", "ledger", CONTENT);
    expect(await relevantKnowledge(QUERY, 3)).toBe("");

    await Bun.write(
      join(memoryRoot(), "2026-04-01.logfmt"),
      formatLine({
        ts: "2026-04-01T00:00:00.000Z",
        type: "learning",
        scope: "ledger",
        content: CONTENT,
        kw: "slow screen,dashboard lag,live updates stutter,ui performance",
      }) + "\n",
    );
    expect(await relevantKnowledge(QUERY, 3)).toContain("websocket frame");
  });

  test("keywords are never rendered: not in the injected line, not in its length", async () => {
    const bare: Memory = {
      ts: "2026-04-02T00:00:00.000Z",
      type: "learning",
      scope: "ledger",
      content: CONTENT,
      file: "",
      index: 0,
    };
    const tagged: Memory = { ...bare, kw: ["slow screen", "dashboard lag", "live updates stutter"] };
    expect(formatMemory(tagged)).toBe(formatMemory(bare));

    const block = await (async () => {
      await Bun.write(join(memoryRoot(), "2026-04-02.logfmt"), formatLine({
        ts: tagged.ts, type: tagged.type, scope: tagged.scope, content: tagged.content, kw: tagged.kw!.join(","),
      }) + "\n");
      return relevantKnowledge(QUERY, 3);
    })();
    expect(block).toContain("websocket frame");
    for (const k of tagged.kw!) expect(block).not.toContain(k);
  });

  test("scoreMemories indexes keywords into the same haystack as the prose", () => {
    const rows: Memory[] = [
      { ts: "2026-04-03T00:00:00.000Z", type: "learning", scope: "a", content: "alpha widget fact about the parser", file: "", index: 0 },
      {
        ts: "2026-04-03T00:00:01.000Z",
        type: "learning",
        scope: "b",
        content: "beta widget fact about the renderer",
        kw: ["tokenise input", "lexing", "parsing"],
        file: "",
        index: 1,
      },
    ];
    // "parsing" is in no content — only the second row's index knows it.
    const hits = scoreMemories("how does the lexing and parsing step work", rows, 3);
    expect(hits.map((m) => m.scope)).toEqual(["b"]);
  });

  test("memory_recall finds a row by its keywords, not only its prose", async () => {
    const loaded = await loadPlugin(root);
    setRepoScope(null);
    // Ground the session: a ref-free settled row needs observed engagement,
    // exactly as for any other write (capture.test.ts / portable.test.ts).
    await loaded["tool.execute.after"]!(
      { tool: "read", sessionID: "ses-kw", callID: "C1", args: { filePath: "src/search.ts" } },
      { title: "read", output: "content", metadata: {} },
    );
    const out = await loaded.tool.memory_remember!.execute({
      type: "pattern",
      scope: "search",
      content: "full-text search runs through meilisearch with a 5 second debounce",
      kw: ["instant search", "typo tolerance", "search-as-you-type"],
    });
    expect(out).toContain("Remembered:");

    const byKeyword = await loaded.tool.memory_recall!.execute({ query: "typo tolerance" });
    expect(byKeyword).toContain("meilisearch");
    const byProse = await loaded.tool.memory_recall!.execute({ query: "meilisearch debounce" });
    expect(byProse).toContain("meilisearch");
    await loaded.cleanup();
  });
});

// --- recency tie-break (#40 item 2) ---------------------------------------------

describe("recency tie-break", () => {
  const OLD = "2026-01-01T00:00:00.000Z";
  const NEW = "2026-06-01T00:00:00.000Z";

  function seedPair(openTs: string | null): void {
    // Identical vocabularies, so the IDF score is a true tie and only the
    // documented cascade can order them.
    seedAt(OLD, "learning", "reports", "alpha bravo reporting rule one", openTs === OLD ? { status: "open" } : {});
    seedAt(NEW, "learning", "reports", "alpha bravo reporting rule two", openTs === NEW ? { status: "open" } : {});
  }

  test("between two equally scored rows the newer one wins", async () => {
    seedPair(null);
    const top = scoreMemories("alpha bravo reporting", await loadAll(), 2);
    expect(top.map((m) => m.ts)).toEqual([NEW, OLD]);
    expect(await relevantKnowledge("alpha bravo reporting", 2)).toContain("rule two");
  });

  test("an open thread still outranks a newer settled row — recency breaks ties AFTER the frontier", async () => {
    seedPair(OLD);
    const top = scoreMemories("alpha bravo reporting", await loadAll(), 2);
    expect(top.map((m) => m.ts)).toEqual([OLD, NEW]);
  });

  test("a real score difference is never overridden by recency", async () => {
    seedAt(OLD, "learning", "reports", "alpha bravo reporting rule with the rare word molybdenum");
    seedAt(NEW, "learning", "reports", "alpha bravo reporting rule one");
    const top = scoreMemories("alpha bravo reporting molybdenum", await loadAll(), 2);
    expect(top[0]?.content).toContain("molybdenum");
  });

  test("the same instant written in two stamp formats is a tie, not a swap", async () => {
    // String-comparing ISO stamps says "…:01Z" > "…:01.000Z", so a legacy
    // second-precision row used to outrank a millisecond row from the very
    // same instant. Recency compares instants, not glyphs: the tie falls
    // through to insertion order.
    seedAt("2026-03-01T09:00:01.000Z", "learning", "reports", "alpha bravo reporting rule one");
    seedAt("2026-03-01T09:00:01Z", "learning", "reports", "alpha bravo reporting rule two");
    const top = scoreMemories("alpha bravo reporting", await loadAll(), 2);
    expect(top.map((m) => m.ts)).toEqual(["2026-03-01T09:00:01.000Z", "2026-03-01T09:00:01Z"]);
  });
});
