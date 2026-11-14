// #223: the viewer must not serve the store unauthenticated over a LAN-facing
// bind. A non-loopback host (bind or allowed-names) mints a startup token and
// every request — reads included — must present it; loopback-only keeps the
// token-free flow. Real child process, real HTTP, same pattern as
// viewer-startup.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeStore } from "./helpers/remove-store.ts";

const EVAL = `
import { startViewer } from "./src/viewer/server.ts";
import { readFileSync, existsSync } from "node:fs";
const viewer = await startViewer(0);
const base = "http://127.0.0.1:" + viewer.server.port;
const tokenPath = process.env.OPENCODE_MEMORY_DIR + "/viewer.token";
const check = (name, cond) => { if (!cond) throw new Error("FAIL " + name); };
try {
  if (process.env.OSI_AUTH_TEST === "loopback") {
    check("loopback page open", (await fetch(base + "/")).status === 200);
    check("loopback data open", (await fetch(base + "/api/data")).status === 200);
    check("loopback mints nothing", !existsSync(tokenPath));
    check("loopback token null", viewer.token == null);
  } else {
    check("read refused", (await fetch(base + "/api/data")).status === 401);
    check("page refused", (await fetch(base + "/")).status === 401);
    const edit = await fetch(base + "/api/edit", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check("mutation refused", edit.status === 401);
    const token = readFileSync(tokenPath, "utf8").trim();
    check("token shape", /^[0-9a-f]{64}$/.test(token));
    check("token returned", viewer.token === token);
    const wrong = await fetch(base + "/api/data", { headers: { authorization: "Bearer " + "0".repeat(64) } });
    check("wrong token refused", wrong.status === 401);
    const bearer = await fetch(base + "/api/data", { headers: { authorization: "Bearer " + token } });
    check("bearer accepted", bearer.status === 200);
    const page = await fetch(base + "/?token=" + token);
    check("bootstrap page", page.status === 200);
    const setCookie = page.headers.get("set-cookie") ?? "";
    check("cookie issued", setCookie.includes("osi-viewer=" + token) && setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Strict"));
    const viaCookie = await fetch(base + "/api/data", { headers: { cookie: "osi-viewer=" + token } });
    check("cookie accepted", viaCookie.status === 200);
    const apiQuery = await fetch(base + "/api/data?token=" + token);
    check("query token only on /", apiQuery.status === 401);
    // F2 (#223 review): a stale cookie must not shadow a valid credential.
    const stale = "0".repeat(64);
    const staleOnly = await fetch(base + "/", { headers: { cookie: "osi-viewer=" + stale } });
    check("stale cookie alone refused", staleOnly.status === 401);
    const staleBootstrap = await fetch(base + "/?token=" + token, { headers: { cookie: "osi-viewer=" + stale } });
    check("bootstrap beats stale cookie", staleBootstrap.status === 200);
    const staleBearer = await fetch(base + "/api/data", { headers: { cookie: "osi-viewer=" + stale, authorization: "Bearer " + token } });
    check("bearer beats stale cookie", staleBearer.status === 200);
    // N1 (#223 review): malformed cookie encoding is a bad credential, not a 500.
    const malformed = await fetch(base + "/api/data", { headers: { cookie: "osi-viewer=%" } });
    check("malformed cookie refused, not 500", malformed.status === 401);
    const malformedBearer = await fetch(base + "/api/data", { headers: { cookie: "osi-viewer=%", authorization: "Bearer " + token } });
    check("malformed cookie does not break bearer", malformedBearer.status === 200);
    const mutate = await fetch(base + "/api/delete", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", reason: "auth test" }) });
    check("mutation with token reaches the route", mutate.status !== 401 && mutate.status !== 403);
  }
} finally { viewer.server.stop(true); }
`;

// F1 (#223 review): two viewers starting at once against a fresh store must
// agree on the ONE persisted token — a read/claim/write race made them mint
// different tokens, so each server accepted only its own.
const EVAL_CONCURRENT = `
import { startViewer } from "./src/viewer/server.ts";
const check = (name, cond) => { if (!cond) throw new Error("FAIL " + name); };
const [a, b] = await Promise.all([startViewer(0), startViewer(0)]);
try {
  check("concurrent starts share one token", a.token === b.token && /^[0-9a-f]{64}$/.test(a.token));
  const ra = await fetch("http://127.0.0.1:" + a.server.port + "/api/data", { headers: { authorization: "Bearer " + b.token } });
  check("first server accepts the shared token", ra.status === 200);
  const rb = await fetch("http://127.0.0.1:" + b.server.port + "/api/data", { headers: { authorization: "Bearer " + a.token } });
  check("second server accepts the shared token", rb.status === 200);
} finally { a.server.stop(true); b.server.stop(true); }
`;

// F1 residual (#223 review round 2): the same race on a CORRUPT file — both
// starters read the same corrupt winner and used to replace it
// unconditionally, so they minted different tokens (Linux) or threw EPERM on
// the rename (Windows). Recovery must serialize: both starts resolve with
// one shared token and both servers accept it.
const EVAL_CORRUPT_CONCURRENT = `
import { startViewer } from "./src/viewer/server.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const check = (name, cond) => { if (!cond) throw new Error("FAIL " + name); };
const tokenPath = process.env.OPENCODE_MEMORY_DIR + "/viewer.token";
mkdirSync(process.env.OPENCODE_MEMORY_DIR, { recursive: true });
writeFileSync(tokenPath, "corrupt");
const results = await Promise.allSettled([startViewer(0), startViewer(0)]);
check("both starts resolve", results.every((r) => r.status === "fulfilled"));
const [a, b] = results.map((r) => r.value);
try {
  check("corrupt recovery shares one token", a.token === b.token && /^[0-9a-f]{64}$/.test(a.token));
  check("recovered token persisted", readFileSync(tokenPath, "utf8").trim() === a.token);
  const ra = await fetch("http://127.0.0.1:" + a.server.port + "/api/data", { headers: { authorization: "Bearer " + b.token } });
  check("first server accepts the shared token", ra.status === 200);
  const rb = await fetch("http://127.0.0.1:" + b.server.port + "/api/data", { headers: { authorization: "Bearer " + a.token } });
  check("second server accepts the shared token", rb.status === 200);
} finally { a.server.stop(true); b.server.stop(true); }
`;

// F3 (#223 review round 2): the valid-token reuse path skipped the 0600
// tightening, so a file left world-readable stayed world-readable. Reuse
// must tighten the existing file before accepting it.
const EVAL_REUSE_MODE = `
import { startViewer } from "./src/viewer/server.ts";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
const check = (name, cond) => { if (!cond) throw new Error("FAIL " + name); };
const tokenPath = process.env.OPENCODE_MEMORY_DIR + "/viewer.token";
const seeded = "a".repeat(64);
mkdirSync(process.env.OPENCODE_MEMORY_DIR, { recursive: true });
writeFileSync(tokenPath, seeded);
chmodSync(tokenPath, 0o644);
check("seeded exposed", (statSync(tokenPath).mode & 0o777) === 0o644);
const viewer = await startViewer(0);
try {
  check("seeded token reused", viewer.token === seeded);
  check("reuse tightens the file to 0600", (statSync(tokenPath).mode & 0o777) === 0o600);
  check("reused content intact", readFileSync(tokenPath, "utf8").trim() === seeded);
} finally { viewer.server.stop(true); }
`;

function runViewer(
  env: Record<string, string>,
  root: string,
  evalScript = EVAL,
) {
  return Bun.spawnSync([process.execPath, "--eval", evalScript], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      OPENCODE_MEMORY_DIR: join(root, "memory"),
      OPENCODE_COMMANDS_DIR: join(root, "commands"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
}

describe("viewer token auth (#223)", () => {
  test("loopback-only bind stays token-free and mints no token file", () => {
    const root = mkdtempSync(join(tmpdir(), "osi-viewer-auth-"));
    try {
      const result = runViewer({ OSI_AUTH_TEST: "loopback" }, root);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      removeStore(root);
    }
  });

  test("exposed bind refuses every unauthenticated request and accepts the minted token", () => {
    const root = mkdtempSync(join(tmpdir(), "osi-viewer-auth-"));
    try {
      const result = runViewer(
        {
          OSI_AUTH_TEST: "exposed",
          OPENCODE_VIEWER_HOST: "127.0.0.1",
          OPENCODE_VIEWER_ALLOWED_HOSTS: "192.0.2.10",
        },
        root,
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      removeStore(root);
    }
  });

  test("concurrent first starts on a fresh store share one token", () => {
    const root = mkdtempSync(join(tmpdir(), "osi-viewer-auth-"));
    try {
      const result = runViewer(
        {
          OPENCODE_VIEWER_HOST: "127.0.0.1",
          OPENCODE_VIEWER_ALLOWED_HOSTS: "192.0.2.10",
        },
        root,
        EVAL_CONCURRENT,
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      removeStore(root);
    }
  });

  test("concurrent starts recover a corrupt token file to one shared token", () => {
    const root = mkdtempSync(join(tmpdir(), "osi-viewer-auth-"));
    try {
      const result = runViewer(
        {
          OPENCODE_VIEWER_HOST: "127.0.0.1",
          OPENCODE_VIEWER_ALLOWED_HOSTS: "192.0.2.10",
        },
        root,
        EVAL_CORRUPT_CONCURRENT,
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      removeStore(root);
    }
  });

  test("reusing a valid token tightens an exposed token file to 0600", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "osi-viewer-auth-"));
    try {
      const result = runViewer(
        {
          OPENCODE_VIEWER_HOST: "127.0.0.1",
          OPENCODE_VIEWER_ALLOWED_HOSTS: "192.0.2.10",
        },
        root,
        EVAL_REUSE_MODE,
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      removeStore(root);
    }
  });
});
