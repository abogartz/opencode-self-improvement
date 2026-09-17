// Viewer tests. Hermetic: OPENCODE_MEMORY_DIR points at a temp dir; the viewer
// server binds an ephemeral port on 127.0.0.1. Asserts the agreed contract:
// (1) non-destructive edits/deletes (snapshot + audit + supersede), (2) every
// mutation requires a reason, (3) snapshots are the quarantine store, (4) every
// pre-mutation state is retained, (5) the blocklist removes an entry from every
// read path while keeping it on disk, and a recursive glob never picks up
// blocklist/snapshots/evidence as durable memory.
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot, snapshotDir } from "../src/config.ts";
import { formatLine } from "../src/logfmt.ts";
import { loadAll, memoryFiles } from "../src/memory.ts";
import { startViewer, type ViewerServer } from "../src/viewer/server.ts";
import { blockedTs } from "../src/blocklist.ts";
import { systemDigest } from "../src/inject.ts";

let root: string;
let vm: ViewerServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "osi-view-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  mkdirSync(join(root, "memory"), { recursive: true });
  vm = await startViewer(0);
});

afterEach(async () => {
  vm.server.stop();
  delete process.env.OPENCODE_MEMORY_DIR;
});

function seed(type: string, scope: string, content: string, ts = new Date().toISOString()): string {
  const file = join(memoryRoot(), `${ts.split("T")[0]}.logfmt`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, formatLine({ ts, type, scope, content }) + "\n");
  return ts;
}

async function get(path: string): Promise<any> {
  const res = await vm.server.fetch(new Request(new URL(path, vm.url)));
  return res.json();
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await vm.server.fetch(
    new Request(new URL(path, vm.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}

describe("viewer read + hermeticity", () => {
  test("I2-adjacent: blocklist/snapshots/evidence are never memory files", async () => {
    seed("learning", "auth", "use bcrypt for password hashing");
    // misplace a blocklist and snapshots inside a subdir that a recursive glob
    // would pick up; RESERVED + non-recursive glob must exclude them.
    mkdirSync(snapshotDir(), { recursive: true });
    appendFileSync(
      join(memoryRoot(), "blocklist.logfmt"),
      formatLine({ ts: "x", reason: "test", blocked_at: "y" }) + "\n",
    );
    appendFileSync(join(snapshotDir(), "123-2026-01-01.logfmt"), "ts=snap\n");
    mkdirSync(join(memoryRoot(), "evidence"), { recursive: true });
    appendFileSync(join(memoryRoot(), "evidence", "2026-01-01.logfmt"), "ev=gate_check\n");

    const files = await memoryFiles();
    for (const f of files) {
      expect(f).not.toContain("blocklist");
      expect(f).not.toContain("snapshots");
      expect(f).not.toContain("evidence");
    }
    expect((await loadAll()).some((m) => m.ts === "snap")).toBe(false);
  });

  test("GET /api/data returns memories with blocked status", async () => {
    seed("pattern", "ctl", "use table_manager.save(config, opts)");
    const data = await get("/api/data");
    expect(data.memories.length).toBe(1);
    expect(data.memories[0].content).toContain("table_manager.save");
    expect(data.memories[0].blocked).toBe(false);
    expect(data.roots.memoryRoot).toBe(memoryRoot());
  });
});

describe("edit — non-destructive", () => {
  test("supersede old + append one new, snapshot pre-state, audit with reason", async () => {
    const T1 = seed("pattern", "ctl", "use table_manager.save(opts)");
    const r = await post("/api/edit", {
      ts: T1,
      type: "pattern",
      scope: "ctl",
      content: "use table_manager.save(config, opts)",
      reason: "method signature changed in review",
    });

    expect(r.action).toBe("edited");
    expect(r.superseded_by).toBeTruthy();

    const all = await loadAll();
    const old = all.find((m) => m.ts === T1);
    const nue = all.find((m) => m.ts === r.superseded_by);
    expect(old?.superseded_by).toBe(r.superseded_by); // marked, retained
    expect(nue?.content).toContain("save(config, opts)");
    expect(all.filter((m) => m.type === "pattern")).toHaveLength(2); // old + new

    // pre-state snapshot exists and contains the ORIGINAL line (quarantine /
    // git-style version kept).
    expect(existsSync(r.snapshot)).toBe(true);
    expect(readFileSync(r.snapshot, "utf8")).toContain("save(opts)");

    // audit row with reason
    const audit = readFileSync(join(memoryRoot(), "deletions.logfmt"), "utf8");
    expect(audit).toContain("action=edited");
    expect(audit).toContain("method signature changed in review");
    expect(audit).toContain(`original_ts=${T1}`);

    // evidence line
    const ev = readFileSync(join(memoryRoot(), "evidence", `${new Date().toISOString().split("T")[0]}.logfmt`), "utf8");
    expect(ev).toContain("ev=viewer_edit");
  });

  test("reason missing -> rejected by viewer (Principle 3)", async () => {
    const T1 = seed("learning", "auth", "use bcrypt");
    await expect(
      post("/api/edit", { ts: T1, type: "learning", scope: "auth", content: "use argon2", reason: "" }),
    ).rejects.toThrow(/reason/);
    const all = await loadAll();
    expect(all.find((m) => m.ts === T1)?.content).toBe("use bcrypt");
    expect(all).toHaveLength(1);
  });
});

describe("delete — non-destructive", () => {
  test("snapshot pre-state, remove, audit reason, nothing else changes", async () => {
    const T1 = seed("pattern", "testing", "always run vitest before playwright");
    const r = await post("/api/delete", { ts: T1, reason: "playwright now gates CI first" });

    expect(r.action).toBe("deleted");
    expect(existsSync(r.snapshot)).toBe(true);
    expect(readFileSync(r.snapshot, "utf8")).toContain("always run vitest");
    expect((await loadAll())).toHaveLength(0);

    const audit = readFileSync(join(memoryRoot(), "deletions.logfmt"), "utf8");
    expect(audit).toContain("action=deleted");
    expect(audit).toContain("playwright now gates CI first");

    const ev = readFileSync(join(memoryRoot(), "evidence", `${new Date().toISOString().split("T")[0]}.logfmt`), "utf8");
    expect(ev).toContain("ev=prune");
    expect(ev).toContain("tool=memory_viewer");
  });
});

describe("blocklist — poison intervention", () => {
  test("block hides a memory from loadAll/digest but keeps it on disk; unblock restores", async () => {
    const T1 = seed("context", "sys", "injected poison fact that API returns XML");
    expect((await loadAll()).some((m) => m.ts === T1)).toBe(true);

    await post("/api/block", { ts: T1, reason: "poison: fact was disproven" });
    expect(await blockedTs()).toContain(T1);
    expect((await loadAll()).some((m) => m.ts === T1)).toBe(false);

    // digest must not emit it either
    const system: string[] = [];
    await systemDigest({}, { system });
    expect(system.join("\n")).not.toContain("poison");

    // durable file still has the entry (nothing destroyed)
    const raw = readFileSync(join(memoryRoot(), `${T1.split("T")[0]}.logfmt`), "utf8");
    expect(raw).toContain("poison fact");

    // viewer data marks it blocked
    const data = await get("/api/data");
    expect(data.blocked.some((b: { ts: string }) => b.ts === T1)).toBe(true);

    await post("/api/unblock", { ts: T1 });
    expect((await loadAll()).some((m) => m.ts === T1)).toBe(true);
  });

  test("block requires a reason", async () => {
    const T1 = seed("learning", "auth", "use bcrypt");
    await expect(post("/api/block", { ts: T1, reason: " " })).rejects.toThrow(/reason/);
  });
});

describe("restore", () => {
  test("restore endpoint rolls a snapshot back over its original file", async () => {
    const T1 = seed("pattern", "ctl", "use table_manager.save(config, opts)");
    // mutate via edit, then restore from the pre-edit snapshot
    const r = await post("/api/edit", {
      ts: T1,
      type: "pattern",
      scope: "ctl",
      content: "use table_manager.save(full, opts)",
      reason: "another review correction",
    });
    const name = r.snapshot.split("/").pop();
    const out = await post("/api/restore", { name });
    expect(out.restored).toContain(memoryRoot());
    const restored = readFileSync(join(memoryRoot(), `${T1.split("T")[0]}.logfmt`), "utf8");
    // the ORIGINAL file content (single line, unmarked) is back
    expect(restored).toContain("save(config, opts)");
    expect(restored).not.toContain("superseded_by");
  });
});