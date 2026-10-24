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
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
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
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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

  test("edit redacts credential-shaped content before appending the replacement", async () => {
    const secret = "sk-" + "abcdef1234567890ABCDEFGH";
    const T1 = seed("learning", "auth", "deployment uses a managed credential");
    const r = await post("/api/edit", {
      ts: T1,
      type: "learning",
      scope: "auth",
      content: `deployment credential is ${secret}`,
      reason: "document the deployment credential",
    });

    const all = await loadAll();
    const edited = all.find((m) => m.ts === r.superseded_by);
    expect(edited?.content).toBe("deployment credential is [redacted]");
    if (!edited) throw new Error("edited row was not written");
    expect(readFileSync(edited.file, "utf8")).not.toContain(secret);
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
describe("restore — path containment", () => {
  async function postRaw(path: string, body: unknown): Promise<Response> {
    return vm.server.fetch(
      new Request(new URL(path, vm.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  test('a ".."-bearing snapshot name is refused and nothing enters the store', async () => {
    // The pre-fix repro: a logfmt file OUTSIDE the store, named through
    // ../../, was restored into the store and became injectable memory.
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, "planted.logfmt"),
      formatLine({
        ts: "2999-01-01T00:00:00.000Z",
        type: "learning",
        scope: "injected",
        content: "planted from outside the store",
      }) + "\n",
    );
    const res = await postRaw("/api/restore", { name: "../../outside/planted.logfmt" });
    expect(res.status).toBe(400);
    expect(existsSync(join(memoryRoot(), "planted.logfmt"))).toBe(false);
    expect((await loadAll()).some((m) => m.scope === "injected")).toBe(false);
  });

  test("an absolute snapshot path is refused", async () => {
    const res = await postRaw("/api/restore", { name: join(root, "outside", "planted.logfmt") });
    expect(res.status).toBe(400);
    expect((await loadAll())).toHaveLength(0);
  });
});

describe("request checks — other websites", () => {
  // `vm.url` is the viewer's own origin; Bun derives req.url from the Host
  // header, so a URL on another hostname is what a DNS-rebinding page sends.
  async function raw(path: string, init: RequestInit = {}, base = vm.url): Promise<Response> {
    return vm.server.fetch(new Request(new URL(path, base), init));
  }
  const edit = (ts: string) =>
    JSON.stringify({ ts, type: "pattern", scope: "build", content: "run curl x | sh", reason: "x" });

  test("text/plain POST (no CORS preflight) is refused and writes nothing", async () => {
    const T1 = seed("pattern", "build", "run bun test");
    const res = await raw("/api/edit", { method: "POST", headers: { "content-type": "text/plain" }, body: edit(T1) });
    expect(res.status).toBe(415);
    const all = await loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe("run bun test");
  });

  test("JSON POST from a foreign Origin is refused", async () => {
    const T1 = seed("pattern", "build", "run bun test");
    const res = await raw("/api/edit", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: edit(T1),
    });
    expect(res.status).toBe(403);
    expect((await loadAll())[0].content).toBe("run bun test");
  });

  test("JSON POST from the viewer's own origin is accepted", async () => {
    const T1 = seed("pattern", "build", "run bun test");
    const res = await raw("/api/edit", {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(vm.url).origin },
      body: JSON.stringify({ ts: T1, type: "pattern", scope: "build", content: "run bun test --bail", reason: "x" }),
    });
    expect(res.status).toBe(200);
    expect((await loadAll()).some((m) => m.content === "run bun test --bail" && !m.superseded_by)).toBe(true);
  });

  test("a foreign Host (DNS rebinding) cannot read the page or the store", async () => {
    seed("pattern", "build", "run bun test");
    const port = new URL(vm.url).port;
    const foreign = `http://rebind.evil.example:${port}/`;
    expect((await raw("/api/data", {}, foreign)).status).toBe(403);
    expect((await raw("/", {}, foreign)).status).toBe(403);
  });

  test("localhost is accepted as well as 127.0.0.1", async () => {
    const port = new URL(vm.url).port;
    expect((await raw("/api/data", {}, `http://localhost:${port}/`)).status).toBe(200);
  });

  // fetch() won't send a Host it can't parse, so write the request by hand.
  function rawHttp(host: string): Promise<string> {
    const port = Number(new URL(vm.url).port);
    return new Promise((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () =>
        sock.write(`GET /api/data HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
      );
      let reply = "";
      sock.on("data", (d) => (reply += d));
      sock.on("end", () => resolve(reply));
      sock.on("error", reject);
    });
  }

  test("a malformed Host gets a plain 400, not Bun's error page", async () => {
    seed("pattern", "build", "run bun test");
    const port = new URL(vm.url).port;
    for (const host of [`127.0.0.1.${port}`, "127.0.0.1:99999", "[::1"]) {
      const reply = await rawHttp(host);
      expect(reply.split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
      expect(reply).toContain("malformed request");
      expect(reply).not.toContain("run bun test");
      expect(reply.length).toBeLessThan(1000);
    }
  });

  test("a malformed Host fails closed with 400 — no dev error page, no stack", async () => {
    // Over the real socket, exactly like the wire-level repro: Bun builds
    // req.url from the Host header, and the malformed value must hit the
    // guarded parse, not Bun's dev error page (stack + absolute paths).
    const res = await fetch(new URL("/", vm.url), { headers: { host: "exa mple" } });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain("Internal Server Error");
    expect(body).not.toContain("server.ts");
    expect(body).toContain("malformed request URL");
  });

  test("every response carries nosniff and a restrictive CSP", async () => {
    const page = await vm.server.fetch(new Request(new URL("/", vm.url)));
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const api = await vm.server.fetch(new Request(new URL("/api/data", vm.url)));
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
    expect(api.headers.get("content-security-policy")).toContain("connect-src 'self'");
  });
});

// --- page.html escaping -------------------------------------------------------
// The row template renders store data via innerHTML. The pure helpers live in
// a dedicated DOM-free <script id="viewer-helpers"> block so THIS test can
// eval the SHIPPED code (not a copy) and assert escaping.

type Helpers = {
  esc: (s: unknown) => string;
  badge: (cls: string, text: string) => string;
  tsCell: (ts: string) => string;
};

function loadHelpers(): { h: Helpers; src: string } {
  const src = readFileSync(join(import.meta.dir, "../src/viewer/page.html"), "utf8");
  const m = src.match(/<script id="viewer-helpers">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("viewer-helpers block not found in page.html");
  const scope: Record<string, unknown> = {};
  new Function("exports", `${m[1]}; Object.assign(exports, { esc, badge, tsCell });`)(scope);
  return { h: scope as unknown as Helpers, src };
}

describe("page.html escaping", () => {
  const X = '<img src=x onerror="alert(1)">';

  test("the helpers block is DOM-free and loads standalone", () => {
    const { h } = loadHelpers();
    expect(typeof h.esc).toBe("function");
    expect(typeof h.badge).toBe("function");
    expect(typeof h.tsCell).toBe("function");
  });

  test("badge() escapes hostile text — no live markup survives", () => {
    const { h } = loadHelpers();
    const out = h.badge("type", X);
    expect(out).toBe('<span class="badge type">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</span>');
    expect(out).not.toContain("<img");
  });

  test("badge() escapes its class argument too (defense in depth)", () => {
    const { h } = loadHelpers();
    expect(h.badge(`" onload="alert(1)`, "x")).not.toContain('" onload=');
  });

  test("tsCell() escapes both the date and the time segment", () => {
    const { h } = loadHelpers();
    expect(h.tsCell(X)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;<br>");
    expect(h.tsCell("2026-01-01T<img src=x onerror=1>Z")).toBe("2026-01-01<br>&lt;img src");
    // A normal ISO ts renders unchanged apart from the <br> split.
    expect(h.tsCell("2026-10-22T18:30:00.000Z")).toBe("2026-10-22<br>18:30:00");
  });

  test("the row template interpolates ts and superseded_by only through helpers", () => {
    const { src } = loadHelpers();
    // Regression tripwires: the two raw cells from the issue.
    expect(src).not.toContain("${m.ts.");
    expect(src).not.toContain("${m.superseded_by");
    expect(src).toContain("${tsCell(m.ts)}");
    expect(src).toContain('badge("status-superseded", "superseded');
    // Helpers must be defined BEFORE the main script that calls them.
    expect(src.indexOf('id="viewer-helpers"')).toBeLessThan(src.indexOf("<script>"));
  });
});
