// Input boundaries (zod, src/schema.ts). Three contracts pinned here:
// (1) WIRE: the JSON Schema handed to the host/model is deep-equal to a
//     byte-capture taken before the zod migration — the model-facing contract
//     did not move.
// (2) TOOLS: a malformed tool call returns "invalid arguments ... nothing was
//     done" and writes NOTHING; stringified numerics still work
//     (z.coerce.number, non-breaking by design).
// (3) STORE READER: row identity is `ts`; a non-ISO ts is skipped as
//     malformed — counted in memory_status, never an addressable row.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRepoScope } from "../src/repokey.ts";
import { appendLog, formatLine } from "../src/logfmt.ts";
import { appendMemory, loadAll, malformedCount } from "../src/memory.ts";
import { loadPlugin } from "./harness.ts";
import { startViewer, type ViewerServer } from "../src/viewer/server.ts";

// Captured from main (v0.4.1) via loadPlugin() before the zod migration.
const EXPECTED_WIRE = {
  memory_remember: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["decision", "learning", "preference", "blocker", "context", "pattern"],
        description: "Type of memory",
      },
      scope: { type: "string", description: "Scope/area (e.g., auth, api, ctl)" },
      content: { type: "string", description: "The memory content" },
      issue: { type: "string", description: "Related issue" },
      tags: { type: "array", items: { type: "string" } },
      status: {
        type: "string",
        enum: ["open", "settled"],
        description:
          "open = live planning thread / frontier (surfaced at session start); settled or omitted = durable knowledge",
      },
      global: {
        type: "boolean",
        description:
          "Store cross-project (visible in every repo): user preferences and general tooling habits. Default false = the memory belongs to THIS repo.",
      },
    },
    required: ["type", "scope", "content"],
    additionalProperties: false,
  },
  memory_init: {
    type: "object",
    properties: {
      force: { type: "boolean", description: "Re-run even if initialized (refresh after drift)" },
      mode: {
        type: "string",
        enum: ["fast", "moderate", "full"],
        description: "codebase-memory index mode (default moderate)",
      },
    },
    required: [],
    additionalProperties: false,
  },
  memory_recall: {
    type: "object",
    properties: {
      scope: { type: "string" },
      type: {
        type: "string",
        enum: ["decision", "learning", "preference", "blocker", "context", "pattern"],
      },
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: [],
    additionalProperties: false,
  },
  memory_update: {
    type: "object",
    properties: {
      scope: { type: "string" },
      type: {
        type: "string",
        enum: ["decision", "learning", "preference", "blocker", "context", "pattern"],
      },
      content: { type: "string" },
      query: {
        type: "string",
        description:
          "Row selector: id (ts), clock fragment, or unique content substring. Omit to target the newest active row of scope+type.",
      },
      status: { type: "string", enum: ["open", "settled"] },
    },
    required: ["scope", "type", "content"],
    additionalProperties: false,
  },
  memory_forget: {
    type: "object",
    properties: {
      scope: { type: "string" },
      type: {
        type: "string",
        enum: ["decision", "learning", "preference", "blocker", "context", "pattern"],
      },
      reason: { type: "string", description: "Why this is being deleted (audit)" },
    },
    required: ["scope", "type", "reason"],
    additionalProperties: false,
  },
  memory_list: { type: "object", properties: {}, required: [], additionalProperties: false },
  memory_undo: {
    type: "object",
    properties: {
      list: { type: "boolean", description: "List snapshots" },
      snapshot: {
        type: "string",
        description: "Store-owned snapshot to restore (bare name from list, or its full path)",
      },
      merge: {
        type: "boolean",
        description: "With snapshot: keep rows written after the snapshot instead of refusing",
      },
      force: {
        type: "boolean",
        description: "With snapshot: exact rollback even if the file changed since",
      },
    },
    required: [],
    additionalProperties: false,
  },
  memory_evidence: {
    type: "object",
    properties: {
      date: { type: "string" },
      ev: { type: "string" },
      limit: { type: "number" },
    },
    required: [],
    additionalProperties: false,
  },
  memory_merge_review: {
    type: "object",
    properties: {
      loser: { type: "string", description: "Evidence id of the rival/overlap write to supersede" },
      survivor: { type: "string", description: "Evidence id of the canonical winning write" },
      reason: {
        type: "string",
        description: "Why the survivor is canonical over the loser (written to evidence)",
      },
    },
    required: ["loser", "survivor", "reason"],
    additionalProperties: false,
  },
  memory_export: {
    type: "object",
    properties: {
      scope: { type: "string", description: "Only export memories in this exact scope" },
      file: { type: "string", description: "Destination path (default: <memory-root>/exports/)" },
    },
    required: [],
    additionalProperties: false,
  },
  memory_import: {
    type: "object",
    properties: { file: { type: "string", description: "Path to a .jsonl export file" } },
    required: ["file"],
    additionalProperties: false,
  },
  memory_decay: {
    type: "object",
    properties: {
      olderThanDays: { type: "number", default: 14, description: "Age threshold in days (default 14)" },
      dryRun: {
        type: "boolean",
        default: true,
        description: "Preview only (default true). Set false to actually supersede.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  memory_status: { type: "object", properties: {}, required: [], additionalProperties: false },
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-bound-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
});
afterEach(() => {
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const dayFile = () => join(process.env.OPENCODE_MEMORY_DIR!, `${new Date().toISOString().split("T")[0]}.logfmt`);

describe("wire contract — zod generates the exact pre-zod JSON Schema", () => {
  test("all 13 registered tool inputs deep-equal the capture from main", async () => {
    const { tools } = await loadPlugin(root);
    expect(Object.keys(tools).sort()).toEqual(Object.keys(EXPECTED_WIRE).sort());
    for (const [name, expected] of Object.entries(EXPECTED_WIRE)) {
      expect(tools[name]!.input, name).toEqual(expected);
    }
  });
});

describe("tool boundary — malformed calls are clean errors that do nothing", () => {
  test("tags as a string: rejected, nothing written (pre-zod: no shape check — its fate depended on unrelated gate heuristics)", async () => {
    const { tool } = await loadPlugin(root);
    const out = await tool.memory_remember!.execute({
      type: "learning",
      scope: "s",
      content: "a fact that should never land because tags is not an array",
      tags: "not-an-array",
    });
    expect(out).toContain("invalid arguments");
    expect(out).toContain("nothing was done");
    expect(await loadAll()).toHaveLength(0);
  });

  test("content as a number: rejected at the boundary (pre-zod: only the gate's content-type floor caught this one field)", async () => {
    const { tool } = await loadPlugin(root);
    const out = await tool.memory_remember!.execute({
      type: "learning",
      scope: "s",
      content: 12345,
    });
    expect(out).toContain("invalid arguments");
    expect(await loadAll()).toHaveLength(0);
  });

  test("type outside the enum is rejected before the gate ever sees it", async () => {
    const { tool } = await loadPlugin(root);
    const out = await tool.memory_remember!.execute({
      type: "nonsense",
      scope: "s",
      content: "content is fine but the type is not one of the six",
    });
    expect(out).toContain("invalid arguments");
    expect(await loadAll()).toHaveLength(0);
  });

  test("dryRun as a STRING is rejected, never coerced to true-or-false and executed", async () => {
    const { tool } = await loadPlugin(root);
    await appendMemory({ type: "context", scope: "s", content: "open thread ancient plan about wiring", status: "open" });
    const out = await tool.memory_decay!.execute({ dryRun: "false" });
    expect(out).toContain("invalid arguments");
    // The row is untouched: a string "false" must not flip the dry-run guard.
    expect((await loadAll())[0]!.superseded_by).toBeUndefined();
  });

  test("coercion is non-breaking: a stringified numeric limit still works", async () => {
    const { tool } = await loadPlugin(root);
    for (const c of ["alpha one", "beta two", "gamma three", "delta four", "epsilon five"]) {
      await appendMemory({ type: "learning", scope: "s", content: `note ${c} about deploys` });
    }
    const out = await tool.memory_recall!.execute({ limit: "2" });
    expect(out).toContain("Found 5 (5 total)");
    expect(out.split("note ").length - 1).toBe(2);
  });
});

describe("viewer boundary — malformed POSTs get 400, not coerced rows", () => {
  let vm: ViewerServer;
  beforeEach(async () => {
    vm = await startViewer(0);
  });
  afterEach(() => vm.server.stop());

  // The viewer CSRF guard refuses text/plain POSTs — and a string body in
  // fetch() defaults to exactly that — so the header is part of the contract.
  const post = (path: string, body: unknown) =>
    fetch(`${vm.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("restore-entry with missing fields is refused — the empty-row hole (pre-zod: 200 + junk row)", async () => {
    const res = await post("api/restore-entry", { type: "learning" });
    expect(res.status).toBe(400);
    expect(await text(res)).toContain("invalid request");
    expect(await loadAll()).toHaveLength(0);
  });

  test("edit with ts as an object is refused (pre-zod: String() made it '[object Object]')", async () => {
    const res = await post("api/edit", { ts: {}, type: "learning", scope: "s", content: "c", reason: "r" });
    expect(res.status).toBe(400);
    expect(await loadAll()).toHaveLength(0);
  });

  test("delete with a non-ISO ts is refused — malformed identity cannot be addressed", async () => {
    const res = await post("api/delete", { ts: "hello", reason: "r" });
    expect(res.status).toBe(400);
  });

  test("well-formed restore-entry still works end to end", async () => {
    const res = await post("api/restore-entry", {
      type: "learning",
      scope: "s",
      content: "a properly shaped restored row",
    });
    expect(res.status).toBe(200);
    expect(await loadAll()).toHaveLength(1);
  });

  const text = (r: Response) => r.text();
});

describe("store reader — ts is validated at load", () => {
  test("a row whose ts is not an ISO instant is skipped and counted, not loaded", async () => {
    await appendLog(
      dayFile(),
      formatLine({ ts: "hello", type: "learning", scope: "ops", content: "ghost row with junk identity" }),
    );
    await appendMemory({ type: "learning", scope: "ops", content: "a real row beside the ghost" });
    const mems = await loadAll();
    expect(mems).toHaveLength(1);
    expect(mems[0]!.content).toContain("real row");
    expect(malformedCount()).toBe(1);
  });

  test("ISO instants load, including second precision and offsets in ms", async () => {
    await appendLog(
      dayFile(),
      formatLine({ ts: "2026-01-01T00:00:00Z", type: "learning", scope: "s", content: "second precision ok" }),
    );
    await appendLog(
      dayFile(),
      formatLine({ ts: "2026-01-01T00:00:00.123456Z", type: "learning", scope: "s", content: "fractional precision ok" }),
    );
    expect(await loadAll()).toHaveLength(2);
    expect(malformedCount()).toBe(0);
  });

  test("a structurally valid but impossible date is malformed too (Month 13)", async () => {
    await appendLog(
      dayFile(),
      formatLine({ ts: "2026-13-45T99:99:99.000Z", type: "learning", scope: "s", content: "impossible calendar row" }),
    );
    expect(await loadAll()).toHaveLength(0);
    expect(malformedCount()).toBe(1);
  });

  test("memory_status surfaces the malformed tally; a clean store shows none", async () => {
    const { tool } = await loadPlugin(root);
    const clean = await tool.memory_status!.execute({});
    expect(clean).not.toContain("malformed");
    await appendLog(
      dayFile(),
      formatLine({ ts: "nope", type: "learning", scope: "s", content: "one bad row" }),
    );
    const dirty = await tool.memory_status!.execute({});
    expect(dirty).toContain("1 malformed");
  });
});
