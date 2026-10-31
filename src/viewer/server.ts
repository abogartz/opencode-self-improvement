// Memory Viewer server. Bundled with the plugin: run `bun memory-view` (or
// `bun run src/viewer/server.ts`) from the repo root and open the printed URL.
// Binds 127.0.0.1 only — the memory store is local, personal data. All reads go
// through the same loadAll() used by recall/inject (so blocked entries are
// hidden), and all mutations are non-destructive (snapshot + audit + supersede).
// I2: serves only file data; never writes into any repo.
import { basename, join } from "node:path";
import { serve, type Server } from "bun";
import { z, type ZodTypeAny } from "zod";
import { BlockBody, DeleteBody, EditBody, RestoreEntryBody, UnblockBody, UnrejectBody } from "../schema.ts";
import { deletionsFile, memoryRoot, snapshotDir } from "../config.ts";
import { blockedEntries } from "../blocklist.ts";
import { listSnapshots, restoreSnapshot } from "../undo.ts";
import { appendMemory, loadAll, memoryFiles } from "../memory.ts";
import { parseLine, readLines } from "../logfmt.ts";
import { deleteMemory, editMemory, blockMemory, unblockMemory, unrejectMemory, type MutationResult } from "./mutate.ts";
import { tombstones } from "../tombstones.ts";

const PAGE = join(import.meta.dir, "page.html");
const HOST = process.env.OPENCODE_VIEWER_HOST || "127.0.0.1";
const PORT = Number(process.env.OPENCODE_VIEWER_PORT || 8787);

// Defense-in-depth headers on every response. CSP: the page uses only inline
// script/style and same-origin fetch, so everything else is off — a stored-XSS
// payload gains no exfil channel and no framing.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json" },
  });
}

function error(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

// Binding 127.0.0.1 keeps other machines out, but not other websites open in
// the user's browser. Two checks close that:
// - Host must name this viewer. A DNS-rebinding page reaches 127.0.0.1 under
//   its own hostname, so its requests arrive with a foreign Host.
// - Writes must be JSON from this viewer's own origin. A cross-site form or
//   no-cors fetch can POST text/plain without a CORS preflight, and every
//   memory edited here is injected into the agent's system prompt.
// A viewer deliberately exposed under another name (OPENCODE_VIEWER_HOST set
// to a LAN address, a hostname) can list it in OPENCODE_VIEWER_ALLOWED_HOSTS.
function allowedHostnames(): Set<string> {
  const extra = (process.env.OPENCODE_VIEWER_ALLOWED_HOSTS ?? "").split(",");
  const names = ["127.0.0.1", "localhost", "::1", HOST, ...extra]
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
    .map((n) => (n.includes(":") && !n.startsWith("[") ? `[${n}]` : n));
  return new Set(names);
}

function rejectRequest(req: Request, url: URL, port: number): Response | null {
  if (!allowedHostnames().has(url.hostname) || (url.port || "80") !== String(port)) {
    return error("unexpected Host header", 403);
  }
  if (req.method === "GET" || req.method === "HEAD") return null;
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin) return error("cross-origin request refused", 403);
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return error("content-type must be application/json", 415);
  return null;
}

interface Row {
  ts: string;
  type: string;
  scope: string;
  content: string;
  reason?: string;
  // Origin stamp (#129): what the row carried when it was deleted, so the
  // restore-entry round trip can restore the row's ORIGINAL visibility.
  repo?: string;
  repoPath?: string;
}

// Deleted entries live only in the audit log (their memory line was removed),
// so surface the recorded data + reason from deletions.logfmt.
async function deletedRows(): Promise<Row[]> {
  const lines = await readLines(deletionsFile());
  return lines
    .map((l) => parseLine(l))
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .map((f) => ({
      ts: String(f.original_ts ?? f.ts ?? ""),
      type: String(f.type ?? ""),
      scope: String(f.scope ?? ""),
      content: String(f.content ?? ""),
      reason: String(f.reason ?? ""),
      ...(typeof f.repo === "string" && f.repo ? { repo: f.repo } : {}),
      ...(typeof f.repoPath === "string" && f.repoPath ? { repoPath: f.repoPath } : {}),
    }));
}

// Blocked entries are still on disk but hidden by the blocklist; scan every
// memory file and keep the ones whose ts is blocked, with their full data.
async function blockedRows(): Promise<Row[]> {
  const blocked = await blockedEntries();
  const byTs = new Map(blocked.map((b) => [b.ts, b.reason]));
  const out: Row[] = [];
  for (const file of await memoryFiles()) {
    for (const line of await readLines(file)) {
      const f = parseLine(line);
      if (!f || typeof f.ts !== "string") continue;
      if (!byTs.has(f.ts)) continue;
      out.push({
        ts: f.ts,
        type: String(f.type ?? ""),
        scope: String(f.scope ?? ""),
        content: String(f.content ?? ""),
        reason: byTs.get(f.ts) ?? "",
      });
    }
  }
  return out;
}

export interface ViewerServer {
  server: Server<any>;
  url: string;
}

export async function startViewer(port: number = PORT): Promise<ViewerServer> {
  const page = await Bun.file(PAGE).text();
  const server = serve({
    hostname: HOST,
    port,
    // Without this, an uncaught throw gets Bun's development error page, which
    // includes the stack trace and local file paths. The stack still goes to
    // the terminal.
    error: (e) => {
      console.error(e);
      return error("internal error", 500);
    },
    fetch(req, srv) {
      // Bun builds req.url from the request's Host header. A malformed Host
      // (`127.0.0.1.8787`, an out-of-range port, `exa mple`) makes it
      // unparseable, and the URL parse THROWs — before rejectRequest could
      // answer. Letting that escape hands the caller Bun's dev error page
      // (stack + absolute paths), so the parse itself is the first guarded
      // step.
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return error("malformed request URL (bad Host header?)", 400);
      }
      const rejected = rejectRequest(req, url, server.port ?? port);
      if (rejected) return rejected;
      if (url.pathname === "/") {
        return new Response(page, {
          headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
        });
      }
      if (req.method === "GET" && url.pathname === "/api/data") {
        return loaded().then(
          (d) => json(d),
          () => error("failed to load memory data"),
        );
      }
      return route(req, url).catch((e) => error(e instanceof Error ? e.message : String(e)));
    },
  });
  const bound = server.port ?? port;
  return { server, url: `http://${HOST}:${bound}/` };
}

async function loaded(): Promise<Record<string, unknown>> {
  const [memories, blocked, deleted, snaps, rejections] = await Promise.all([
    loadAll(),
    blockedRows(),
    deletedRows(),
    listSnapshots(),
    tombstones(),
  ]);
  const blockedByTs = new Set(blocked.map((b) => b.ts));
  return {
    roots: { memoryRoot: memoryRoot(), snapshotDir: snapshotDir() },
    memories: memories.map((m) => ({
      ts: m.ts,
      type: m.type,
      scope: m.scope,
      content: m.content,
      issue: m.issue,
      tags: m.tags,
      superseded_by: m.superseded_by,
      reason: m.reason,
      // The viewer is the explicit ADMIN read surface (header comment): it
      // lists every repository, and now says WHICH one each row belongs to.
      repo: m.repo,
      repoPath: m.repoPath,
      blocked: blockedByTs.has(m.ts),
    })),
    blocked,
    deleted,
    // #35: the value-keyed rejections. Hashes and metadata only — the store
    // never held the prose, so there is nothing to reveal here either. The
    // sketch is omitted: it is matching machinery, not something a reader can
    // act on.
    rejections: rejections.map((t) => ({
      ch: t.ch,
      reason: t.reason,
      source: t.source,
      scope: t.scope ?? "",
      type: t.type ?? "",
      rejected_at: t.rejected_at,
    })),
    snapshots: snaps.map((s) => ({ name: s.name, bytes: s.bytes })),
  };
}

async function route(req: Request, url: URL): Promise<Response> {
  if (req.method === "POST") {
    const body: unknown = await req.json().catch(() => ({}));
    if (url.pathname === "/api/edit") return parseWith(EditBody, body, editRoute);
    if (url.pathname === "/api/delete") return parseWith(DeleteBody, body, deleteRoute);
    if (url.pathname === "/api/block") return parseWith(BlockBody, body, blockRoute);
    if (url.pathname === "/api/unblock") return parseWith(UnblockBody, body, unblockRoute);
    if (url.pathname === "/api/unreject") return parseWith(UnrejectBody, body, unrejectRoute);
    if (url.pathname === "/api/restore-entry") return parseWith(RestoreEntryBody, body, restoreEntryRoute);
    // /api/restore is deliberately NOT schema-parsed here: its name check is
    // basename + pinned-grammar CONTAINMENT, not a shape gate,
    // and its regression tests pin that behavior.
    if (url.pathname === "/api/restore") return restoreRoute(body as Record<string, unknown>);
  }
  return json({ error: "not found" }, 404);
}

// Boundary shape check for POST routes: the old `String(body.ts ?? "")`
// coercion made ANY junk
// fit — ts:{} became "[object Object]" as a row identity, a missing content
// appended an empty row. A malformed call now gets a clean 400; semantics
// (which row, what for) stay with the mutate layer.
function parseWith<S extends ZodTypeAny>(
  schema: S,
  body: unknown,
  h: (data: z.infer<S>) => Response | Promise<Response>,
): Response | Promise<Response> {
  const p = schema.safeParse(body);
  if (!p.success) {
    return error(
      `invalid request: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      400,
    );
  }
  return h(p.data);
}

async function editRoute(body: z.infer<typeof EditBody>): Promise<Response> {
  const r: MutationResult = await editMemory({
    ts: body.ts,
    type: body.type,
    scope: body.scope,
    content: body.content,
    issue: body.issue,
    tags: body.tags,
    reason: body.reason,
  });
  return json(r);
}

async function deleteRoute(body: z.infer<typeof DeleteBody>): Promise<Response> {
  return json(await deleteMemory({ ts: body.ts, reason: body.reason }));
}

async function blockRoute(body: z.infer<typeof BlockBody>): Promise<Response> {
  return json({ ts: await blockMemory(body) });
}

async function unblockRoute(body: z.infer<typeof UnblockBody>): Promise<Response> {
  return json({ unblocked: await unblockMemory(body.ts) });
}

// The only way a rejection is ever lifted (#35). Human-only: the plugin exposes
// no tool for this, so a session whose write was refused cannot clear the
// refusal and re-submit the rejected value.
async function unrejectRoute(body: z.infer<typeof UnrejectBody>): Promise<Response> {
  return json({ unrejected: await unrejectMemory(body.ch) });
}

async function restoreEntryRoute(body: z.infer<typeof RestoreEntryBody>): Promise<Response> {
  // Origin survives the restore round trip (#129): when the audit line carried
  // a repo stamp, the restored row carries it again — the viewer's own missing
  // repository scope must never be what decides a row's visibility. No repo
  // fields = the documented legacy/global restore path, unchanged.
  const t = await appendMemory({
    type: body.type,
    scope: body.scope,
    content: body.content,
    repo: body.repo,
    repoPath: body.repoPath,
  });
  return json({ restored: t });
}

async function restoreRoute(body: Record<string, unknown>): Promise<Response> {
  // Path containment: name arrives raw from the wire. Basename it,
  // then pin it to the real snapshot-name grammar — `<epoch-ms>-<YYYY-MM-DD>.logfmt`
  // — so neither path join below can be steered outside snapshots/ and the
  // store root with a `..` or absolute name.
  const name = basename(String(body.name ?? ""));
  if (!/^\d+-\d{4}-\d{2}-\d{2}\.logfmt$/.test(name)) {
    return error("invalid snapshot name", 400);
  }
  // Explicit human admin action: exact rollback. The pre-restore snapshot the
  // dropped rows can be recovered from is taken by restoreSnapshot itself,
  // under the store lock — snapshotting here instead would miss anything
  // another session appended between this call and the rollback.
  const res = await restoreSnapshot(join(snapshotDir(), name), memoryRoot(), "force");
  return json({
    restored: res.target,
    safety: res.safety ?? null,
    rolledBack: res.concurrentAdded.length + res.concurrentChanged.length,
  });
}

if (import.meta.main) {
  startViewer(PORT).then(({ url }) => {
    console.log(`\nMemory Viewer: ${url}\n(127.0.0.1 only; snapshot+audit are mandatory on every edit/delete)`);
  });
}
