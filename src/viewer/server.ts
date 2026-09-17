// Memory Viewer server. Bundled with the plugin: run `bun memory-view` (or
// `bun run src/viewer/server.ts`) from the repo root and open the printed URL.
// Binds 127.0.0.1 only — the memory store is local, personal data. All reads go
// through the same loadAll() used by recall/inject (so blocked entries are
// hidden), and all mutations are non-destructive (snapshot + audit + supersede).
// I2: serves only file data; never writes into any repo.
import { join } from "node:path";
import { serve, type Server } from "bun";
import { deletionsFile, memoryRoot, snapshotDir } from "../config.ts";
import { blockedEntries } from "../blocklist.ts";
import { listSnapshots, restoreSnapshot } from "../undo.ts";
import { appendMemory, loadAll, memoryFiles } from "../memory.ts";
import { parseLine, readLines } from "../logfmt.ts";
import { deleteMemory, editMemory, addBlock, removeBlock, type MutationResult } from "./mutate.ts";

const PAGE = join(import.meta.dir, "page.html");
const HOST = process.env.OPENCODE_VIEWER_HOST || "127.0.0.1";
const PORT = Number(process.env.OPENCODE_VIEWER_PORT || 8787);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

interface Row {
  ts: string;
  type: string;
  scope: string;
  content: string;
  reason?: string;
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
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8" },
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
  const [memories, blocked, deleted, snaps] = await Promise.all([
    loadAll(),
    blockedRows(),
    deletedRows(),
    listSnapshots(),
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
      blocked: blockedByTs.has(m.ts),
    })),
    blocked,
    deleted,
    snapshots: snaps.map((s) => ({ name: s.name, bytes: s.bytes })),
  };
}

async function route(req: Request, url: URL): Promise<Response> {
  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (url.pathname === "/api/edit") return editRoute(body);
    if (url.pathname === "/api/delete") return deleteRoute(body);
    if (url.pathname === "/api/block") return blockRoute(body);
    if (url.pathname === "/api/unblock") return unblockRoute(body);
    if (url.pathname === "/api/restore-entry") return restoreEntryRoute(body);
    if (url.pathname === "/api/restore") return restoreRoute(body);
  }
  return json({ error: "not found" }, 404);
}

async function editRoute(body: Record<string, unknown>): Promise<Response> {
  const r: MutationResult = await editMemory({
    ts: String(body.ts ?? ""),
    type: String(body.type ?? ""),
    scope: String(body.scope ?? ""),
    content: String(body.content ?? ""),
    issue: typeof body.issue === "string" ? body.issue : undefined,
    tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
    reason: String(body.reason ?? ""),
  });
  return json(r);
}

async function deleteRoute(body: Record<string, unknown>): Promise<Response> {
  return json(await deleteMemory({ ts: String(body.ts ?? ""), reason: String(body.reason ?? "") }));
}

async function blockRoute(body: Record<string, unknown>): Promise<Response> {
  return json({ ts: await addBlock(String(body.ts ?? ""), String(body.reason ?? "")) });
}

async function unblockRoute(body: Record<string, unknown>): Promise<Response> {
  return json({ unblocked: await removeBlock(String(body.ts ?? "")) });
}

async function restoreEntryRoute(body: Record<string, unknown>): Promise<Response> {
  const t = await appendMemory({
    type: String(body.type ?? ""),
    scope: String(body.scope ?? ""),
    content: String(body.content ?? ""),
  });
  return json({ restored: t });
}

async function restoreRoute(body: Record<string, unknown>): Promise<Response> {
  const target = await restoreSnapshot(join(snapshotDir(), String(body.name ?? "")), memoryRoot());
  return json({ restored: target });
}

if (import.meta.main) {
  startViewer(PORT).then(({ url }) => {
    console.log(`\nMemory Viewer: ${url}\n(127.0.0.1 only; snapshot+audit are mandatory on every edit/delete)`);
  });
}
