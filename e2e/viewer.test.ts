// Viewer end-to-end scenarios (#241): the real viewer server (the same
// src/viewer/server.ts `bun memory-view` runs) booted against a fresh isolated
// store, driven over real HTTP exactly like a browser would — page, data
// round, every mutation route, and the DNS-rebinding / CSRF / content-type
// guards. No opencode host is involved: the viewer's contract is HTTP + the
// shared store files, and both sides here are the real implementations.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "./support/harness.ts";

const guests: { root: string; stop: () => void }[] = [];

afterEach(() => {
  for (const g of guests.splice(0)) {
    g.stop();
    rmSync(g.root, { recursive: true, force: true });
  }
});
afterAll(() => {
  // Nothing global outlives the scenarios; afterEach already reaped.
});

interface Viewer {
  root: string;
  memoryDir: string;
  port: number;
  stop: () => void;
}

/** Boot the real viewer against an isolated store; resolve its chosen port. */
async function startViewer(storeLines: string): Promise<Viewer> {
  const root = mkdtempSync(join(tmpdir(), "psi-e2e-viewer-"));
  const memoryDir = join(root, "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, "2026-01-01.logfmt"), storeLines);

  const child = Bun.spawn([process.execPath, join(REPO, "src", "viewer", "server.ts")], {
    cwd: REPO,
    env: {
      HOME: join(root, "home"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      OPENCODE_MEMORY_DIR: memoryDir,
      OPENCODE_VIEWER_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let port = 0;
  const deadline = Date.now() + 15_000;
  let out = "";
  const reader = child.stdout.getReader();
  while (Date.now() < deadline && !port) {
    const { value } = await reader.read();
    if (!value) break;
    out += new TextDecoder().decode(value);
    const m = out.match(/Memory Viewer: http:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) port = Number(m[1]);
  }
  if (!port) throw new Error(`viewer did not come up: ${out}`);
  return { root, memoryDir, port, stop: () => child.kill(9) };
}

interface Resp {
  status: number;
  contentType: string;
  body: string;
}

/** Raw HTTP so hostile Host headers and non-JSON content types are reachable. */
function req(
  v: Viewer,
  method: string,
  path: string,
  opts: { body?: string; host?: string; origin?: string; contentType?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: "127.0.0.1",
        port: v.port,
        method,
        path,
        headers: {
          ...(opts.host ? { host: opts.host } : {}),
          ...(opts.origin ? { origin: opts.origin } : {}),
          ...(opts.contentType ? { "content-type": opts.contentType } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const jsonReq = (v: Viewer, path: string, payload: unknown) =>
  req(v, "POST", path, {
    body: JSON.stringify(payload),
    contentType: "application/json",
    origin: `http://127.0.0.1:${v.port}`,
  });

function storeLines(memoryDir: string): string {
  return readdirSync(memoryDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.logfmt$/.test(f))
    .flatMap((f) => readFileSync(join(memoryDir, f), "utf8").trim().split("\n").filter(Boolean))
    .join("\n");
}

const SEED =
  'ts=2026-01-01T00:00:00.000Z type=learning scope=viewer-e2e content="the viewer seed row alpha describes the nightly board sync"\n' +
  'ts=2026-01-01T00:00:01.000Z type=learning scope=viewer-e2e content="the viewer seed row beta describes the quarterly archive sweep"\n';
const TS_A = "2026-01-01T00:00:00.000Z";
const TS_B = "2026-01-01T00:00:01.000Z";

describe("Feature: viewer routes over real HTTP (#241)", () => {
  test("Scenario: the admin page and /api/data serve the store", async () => {
    const v = await startViewer(SEED);
    guests.push(v);

    // Then the page is HTML and the data round carries both rows + roots
    const page = await req(v, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.contentType).toInclude("text/html");
    expect(page.body.toLowerCase()).toContain("<html");

    const data = await req(v, "GET", "/api/data");
    expect(data.status).toBe(200);
    const parsed = JSON.parse(data.body);
    expect(parsed.memoryRoot ?? parsed.roots?.memoryRoot ?? v.memoryDir).toInclude("memory");
    const tss = (parsed.memories as { ts: string }[]).map((m) => m.ts);
    expect(tss).toContain(TS_A);
    expect(tss).toContain(TS_B);
  }, 60_000);

  test("Scenario: edit supersedes, delete audits, restore-entry replays", async () => {
    const v = await startViewer(SEED);
    guests.push(v);

    // When a row is edited through the viewer, the replacement supersedes it
    const edit = await jsonReq(v, "/api/edit", {
      ts: TS_A,
      type: "learning",
      scope: "viewer-e2e",
      content: "the viewer seed row alpha now describes the weekly board sync",
      reason: "e2e characterization",
    });
    expect(edit.status).toBe(200);
    const edited = JSON.parse(edit.body);
    expect(edited.action).toBe("edited");
    expect(edited.superseded_by).toBeString();
    let lines = storeLines(v.memoryDir);
    expect(lines).toContain("weekly board sync");
    expect(lines).toContain(`superseded_by=${edited.superseded_by}`);

    // When a row is deleted, it leaves the store and enters the audit log
    const del = await jsonReq(v, "/api/delete", { ts: TS_B, reason: "e2e characterization delete" });
    expect(del.status).toBe(200);
    expect(JSON.parse(del.body).action).toBe("deleted");
    lines = storeLines(v.memoryDir);
    expect(lines).not.toContain("quarterly archive sweep");
    const audit = readFileSync(join(v.memoryDir, "deletions.logfmt"), "utf8");
    expect(audit).toContain("quarterly archive sweep");
    expect(audit).toContain("e2e characterization delete");

    // When the deleted row is restored from the audit panel, it is live again
    const rest = await jsonReq(v, "/api/restore-entry", {
      type: "learning",
      scope: "viewer-e2e",
      content: "the viewer seed row beta describes the quarterly archive sweep",
    });
    expect(rest.status).toBe(200);
    expect(JSON.parse(rest.body).restored).toBeString();
    expect(storeLines(v.memoryDir)).toContain("quarterly archive sweep");
  }, 60_000);

  test("Scenario: block hides a row from the data round; unblock returns it", async () => {
    const v = await startViewer(SEED);
    guests.push(v);

    const block = await jsonReq(v, "/api/block", { ts: TS_A, reason: "e2e characterization block" });
    expect(block.status).toBe(200);
    let parsed = JSON.parse((await req(v, "GET", "/api/data")).body);
    expect((parsed.memories as { ts: string }[]).map((m) => m.ts)).not.toContain(TS_A);
    expect((parsed.blocked as { ts: string }[]).map((b) => b.ts)).toContain(TS_A);
    // The row itself is still on disk — the blocklist hides, never deletes.
    expect(storeLines(v.memoryDir)).toContain("nightly board sync");

    const unblock = await jsonReq(v, "/api/unblock", { ts: TS_A });
    expect(unblock.status).toBe(200);
    parsed = JSON.parse((await req(v, "GET", "/api/data")).body);
    expect((parsed.memories as { ts: string }[]).map((m) => m.ts)).toContain(TS_A);
  }, 60_000);

  test("Scenario: rebinding Host, cross-origin writes and non-JSON bodies are refused", async () => {
    const v = await startViewer(SEED);
    guests.push(v);
    const payload = JSON.stringify({ ts: TS_A, reason: "should never land" });

    // A rebinding page arrives with a foreign Host: refused before any route.
    const rebinding = await req(v, "GET", "/api/data", { host: "evil.example" });
    expect(rebinding.status).toBe(403);
    expect(JSON.parse(rebinding.body).error).toContain("Host");

    // A cross-site form posts text/plain with no preflight: content-type gate.
    const textPlain = await req(v, "POST", "/api/delete", {
      body: payload,
      contentType: "text/plain",
      origin: `http://127.0.0.1:${v.port}`,
    });
    expect(textPlain.status).toBe(415);

    // JSON from a foreign origin: refused.
    const csrf = await req(v, "POST", "/api/delete", {
      body: payload,
      contentType: "application/json",
      origin: "http://evil.example",
    });
    expect(csrf.status).toBe(403);

    // Unknown routes answer the JSON 404, never the page.
    const notFound = await req(v, "GET", "/api/nope");
    expect(notFound.status).toBe(404);
    expect(JSON.parse(notFound.body).error).toBe("not found");

    // Schema rejections: malformed ts, and a mutation without an audit reason.
    const badTs = await jsonReq(v, "/api/edit", {
      ts: "not-an-iso-ts",
      type: "learning",
      scope: "viewer-e2e",
      content: "whatever",
      reason: "e2e negative probe",
    });
    expect(badTs.status).toBe(400);
    const noReason = await jsonReq(v, "/api/delete", { ts: TS_A, reason: "   " });
    expect(noReason.status).toBe(400);
    expect(noReason.body).toInclude("reason is required");
    const emptyBody = await jsonReq(v, "/api/delete", {});
    expect(emptyBody.status).toBe(400);

    // Nothing was deleted or edited: the store still carries both seed rows
    // untouched and no replacement was appended.
    const lines = storeLines(v.memoryDir);
    expect(lines).toContain("nightly board sync");
    expect(lines).toContain("quarterly archive sweep");
    expect(lines).not.toContain("whatever");
    expect(lines.match(/superseded_by=/g)).toBeNull();
  }, 60_000);
});
