// #74 slice 1: memory_export must not write stored credentials verbatim.
// The write side redacts (#67), but rows written before it keep their secrets,
// and export serialised `content` and `issue` as-is — handing any holder of
// the JSONL the credential. Redaction here happens on the value being
// serialised, never on the row: export stays a read path.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoot } from "../src/core/config/paths.ts";
import { dateStr } from "../src/core/time.ts";
import { formatLine } from "../src/core/logfmt/format.ts";
import {
  exportMemories,
  EXPORT_HEADER,
  EXPORT_VERSION,
} from "../src/portable/export.ts";
import { loadAll } from "../src/store/files/load.ts";
import { resetState } from "../src/core/state.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { removeStore } from "./helpers/remove-store.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-export-redact-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  mkdirSync(memoryRoot(), { recursive: true });
});
afterEach(() => {
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

// A legacy row, written straight to the day file the way pre-#67 code did:
// appendMemory would redact the credential before storing it, so the write
// gate never sees this payload — only the export path can.
function seedLegacy(fields: Record<string, unknown>) {
  appendFileSync(
    join(memoryRoot(), `${dateStr()}.logfmt`),
    `${formatLine({ ts: "2026-01-01T00:00:00.000Z", type: "learning", scope: "legacy", ...fields })}\n`,
  );
}

const SK_TOKEN = "sk-" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv";

describe("memory_export redacts stored credentials (#74 slice 1)", () => {
  test("content holding an sk- token exports [redacted], never the token", async () => {
    seedLegacy({ content: `deploy note ${SK_TOKEN} kept for rotation` });
    const res = await exportMemories({ file: "redact-content.jsonl" });
    const text = readFileSync(res.path, "utf8");
    expect(text).not.toContain(SK_TOKEN);
    expect(text).toContain(
      '"content":"deploy note [redacted] kept for rotation"',
    );
  });

  test("issue holding an sk- token exports [redacted], never the token", async () => {
    seedLegacy({
      content: "clean content",
      issue: `token in free text ${SK_TOKEN}`,
    });
    const res = await exportMemories({ file: "redact-issue.jsonl" });
    const text = readFileSync(res.path, "utf8");
    expect(text).not.toContain(SK_TOKEN);
    expect(text).toContain('"issue":"token in free text [redacted]"');
  });

  test("a row with no credential-shaped text serialises byte-identically", async () => {
    seedLegacy({
      content: "run bun test from the repo root",
      status: "settled",
      tags: ["build", "ci"],
      issue: "42",
    });
    const res = await exportMemories({ file: "clean.jsonl" });
    const text = readFileSync(res.path, "utf8");
    const line = text.split("\n")[1];
    expect(line).toBe(
      JSON.stringify({
        ts: "2026-01-01T00:00:00.000Z",
        type: "learning",
        scope: "legacy",
        content: "run bun test from the repo root",
        status: "settled",
        tags: ["build", "ci"],
        kw: undefined,
        issue: "42",
        repo: undefined,
        repoPath: undefined,
      }),
    );
  });

  test("the header line and count are unchanged", async () => {
    seedLegacy({ content: "first row" });
    seedLegacy({
      content: `second row ${SK_TOKEN}`,
      ts: "2026-01-01T00:00:01.000Z",
    });
    const res = await exportMemories({ file: "header.jsonl" });
    expect(res.count).toBe(2);
    const header = JSON.parse(readFileSync(res.path, "utf8").split("\n")[0]);
    expect(header._export).toBe(EXPORT_HEADER);
    expect(header.version).toBe(EXPORT_VERSION);
    expect(header.count).toBe(2);
    expect(typeof header.exportedAt).toBe("string");
  });

  test("export stays a read path: the stored row keeps its original content", async () => {
    seedLegacy({ content: `vault note ${SK_TOKEN}` });
    await exportMemories({ file: "readpath.jsonl" });
    const rows = await loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain(SK_TOKEN);
  });

  // #300: the same rule has to cover the metadata a row carries. New writes
  // cannot put a credential in scope/tags/kw (the schema and the write boundary
  // refuse it), but a row stored before those checks — or hand-edited into the
  // store — exports into a file meant to leave the machine.
  test("scope, tags and kw holding an sk- token export [redacted], never the token", async () => {
    seedLegacy({
      scope: `deploy-${SK_TOKEN}`,
      content: "clean content",
      tags: ["ci", `tok-${SK_TOKEN}`],
      kw: [`key-${SK_TOKEN}`, "build"],
    });
    const res = await exportMemories({ file: "redact-meta.jsonl" });
    const text = readFileSync(res.path, "utf8");
    expect(text).not.toContain(SK_TOKEN);
    const row = JSON.parse(text.split("\n")[1]);
    expect(row.scope).toBe("deploy-[redacted]");
    expect(row.tags).toEqual(["ci", "tok-[redacted]"]);
    expect(row.kw).toEqual(["key-[redacted]", "build"]);
  });

  test("scrubbing metadata still leaves the store byte-unchanged", async () => {
    seedLegacy({
      scope: `deploy-${SK_TOKEN}`,
      content: "clean content",
      tags: [`tok-${SK_TOKEN}`],
    });
    const file = join(memoryRoot(), `${dateStr()}.logfmt`);
    const before = readFileSync(file, "utf8");
    await exportMemories({ file: "meta-readpath.jsonl" });
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
