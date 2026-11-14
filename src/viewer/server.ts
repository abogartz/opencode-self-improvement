// Memory Viewer server. Bundled with the plugin: run `bun memory-view` (or
// `bun run src/viewer/server.ts`) from the repo root and open the printed URL.
// Defaults to 127.0.0.1 — the memory store is local, personal data. All reads go
// through the same loadAll() used by recall/inject (so blocked entries are
// hidden), and all mutations are non-destructive (snapshot + audit + supersede).
// I2: serves only file data; never writes into any repo.
// #223: a non-loopback bind or allowed host mints a startup token (0600, in
// the store root) and every request must present it; loopback stays open.
import { basename, join } from "node:path";
import { linkSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { serve, type Server } from "bun";
import { z, type ZodTypeAny } from "zod";
import {
  BlockBody,
  DeleteBody,
  EditBody,
  RestoreEntryBody,
  UnblockBody,
  UnrejectBody,
  ReleaseQuarantineBody,
} from "../tools/schema.ts";
import {
  deletionsFile,
  memoryRoot,
  snapshotDir,
} from "../core/config/paths.ts";
import { blockedEntries } from "../store/blocklist.ts";
import { LOCK_WRITE, withStoreLock } from "../store/lock.ts";
import { listSnapshots, restoreSnapshot } from "../store/undo.ts";
import { appendMemory } from "../store/files/append.ts";
import { loadAll, memoryFiles } from "../store/files/load.ts";
import { type MemoryStatus } from "../store/model/memory.ts";
import { parseLine } from "../core/logfmt/format.ts";
import { readLines } from "../core/logfmt/read.ts";
import { releaseQuarantinedMemory } from "./mutate.ts";
import {
  isQuarantined,
  quarantineReasons,
} from "../store/quarantine/quarantine.ts";
import {
  deleteMemory,
  editMemory,
  blockMemory,
  unblockMemory,
  unrejectMemory,
  type MutationResult,
} from "./mutate.ts";
import { tombstones } from "../store/tombstones/tombstone.ts";
import { assertViewerWriteAllowed } from "./rejections.ts";
import { preparePrivateFile } from "../core/permissions.ts";

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

function isLoopbackHostname(name: string): boolean {
  // allowedHostnames supplies trimmed, lower-cased names (IPv6 bracketed).
  const host = name.replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  // Closed spellings only: URL parsing throws on IPv6 zone ids. Ambiguous
  // aliases (including abbreviated IPv4) conservatively trigger the warning.
  return host === "::1" || host === "0:0:0:0:0:0:0:1";
}

// #223: exposure without authentication was the defect — with a non-loopback
// bind (or an allowed non-loopback name) every read and mutation was open HTTP
// for the whole LAN. A token is now minted at startup and every request must
// present it: the Host/Origin layer stays as the CSRF defence it always was,
// but it is no longer the only thing between the LAN and the store.
const TOKEN_FILE = "viewer.token";
const TOKEN_COOKIE = "osi-viewer";
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

function tokenPath(): string {
  return join(memoryRoot(), TOKEN_FILE);
}

// Reuse a token already in the file so a restart does not invalidate URLs a
// human has open (and two viewers sharing a store share one token); mint a
// fresh one otherwise. Concurrent first starts — same process or separate
// processes — must agree on ONE token (F1, #223 review): the claim is an
// atomic hard-link of a fully-written 0600 temp, so exactly one starter's
// content lands at the path (link(2) refuses an existing target), and every
// loser reads back the winner's complete token instead of overwriting the
// file with its own.
//
// F1 residual (#223 review round 2): the hard-link claim solves an ABSENT
// file, not a CORRUPT one — two starters that both read the same corrupt
// winner used to replace it unconditionally, disagreeing on Linux and
// throwing EPERM on Windows. Recovery is now serialized twice over: within
// one process every mint runs through this promise chain, so the second
// starter re-reads the repaired file instead of racing the repair; across
// processes an O_EXCL lock file elects one repairman and the others adopt
// its token. A replacement is never unconditional.
//
// F3 (#223 review round 2): the reuse path must enforce the 0600 contract
// too. preparePrivateFile tightens an existing file to owner-only (keeping
// owner bits, refusing a final-component symlink), so a token file left
// world-readable is repaired before it is accepted — restoring what the
// round-1 early return bypassed.
let mintTail: Promise<unknown> = Promise.resolve();

function mintViewerToken(): Promise<string> {
  const run = mintTail.then(() => mintTokenOnce());
  mintTail = run.catch(() => {});
  return run;
}

function readToken(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

async function mintTokenOnce(): Promise<string> {
  const path = tokenPath();
  const prior = readToken(path);
  if (TOKEN_SHAPE.test(prior)) {
    preparePrivateFile(path);
    return prior;
  }
  const token = randomBytes(32).toString("hex");
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    preparePrivateFile(tmp);
    await Bun.write(tmp, token);
    try {
      linkSync(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const winner = readToken(path);
      if (TOKEN_SHAPE.test(winner)) return winner;
      return await recoverCorruptToken(path, tmp, token);
    }
    return token;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Repair a corrupt token file: exactly one starter replaces the file and the
// rest adopt its token (F1 residual, #223 review). The repair also keeps Windows
// from renaming onto a file a rival starter is mid-read — the observed EPERM.
//
// It takes the STORE's lock to do it. It used to take its own O_EXCL
// `.recover` file, which is the #407 shape exactly: the state of the lock lived
// in a directory entry, and on Windows that entry outlives the holder whenever
// a third-party handle is open without FILE_SHARE_DELETE. The age-based steal
// here could not rescue that case either, because the steal is itself an unlink
// and the same refusal applies to it — a viewer that hit it could never start
// again.
async function recoverCorruptToken(
  path: string,
  tmp: string,
  token: string,
): Promise<string> {
  return withStoreLock(
    path,
    async () => {
      // Re-read inside the lock: a rival repair may have completed while this
      // call waited, and its token is the one URLs in this store already carry.
      const settled = readToken(path);
      if (TOKEN_SHAPE.test(settled)) return settled;
      renameSync(tmp, path);
      return token;
    },
    LOCK_WRITE,
  );
}

function tokenMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// No decodeURIComponent: the cookie is a fixed-hex token we mint and set
// verbatim, and decoding junk like `osi-viewer=%` throws URIError on the
// auth path — a 500 where a malformed credential must simply be refused
// (N1, #223 review). The raw value cannot match, so it falls through to 401.
function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name)
      return part.slice(eq + 1).trim();
  }
  return null;
}

function exposureWarning(path: string): string {
  return (
    "[memory-viewer] WARNING: non-loopback hosts are allowed. Every request " +
    "must present the startup-minted token (Authorization: Bearer, the " +
    TOKEN_COOKIE +
    " cookie, or ?token= on /); requests without it are refused with 401. " +
    "Token: " +
    path +
    " (mode 0600). Plain HTTP still exposes the token on the wire — use " +
    "only on a network you trust."
  );
}

function rejectRequest(req: Request, url: URL, port: number): Response | null {
  if (
    !allowedHostnames().has(url.hostname) ||
    (url.port || "80") !== String(port)
  ) {
    return error("unexpected Host header", 403);
  }
  if (req.method === "GET" || req.method === "HEAD") return null;
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin)
    return error("cross-origin request refused", 403);
  const type = (req.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (type !== "application/json")
    return error("content-type must be application/json", 415);
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
  // #207: the deleted row's metadata, read back from the audit line, so the
  // deleted-entry UI can show WHAT is being restored — in particular whether
  // it is quarantined. Only deletion rows carry these; blocked rows do not.
  tags?: string[];
  kw?: string[];
  issue?: string;
  status?: string;
  quarantined?: boolean;
}

// Comma-joined scalars back into arrays, the inverse of the audit write.
function splitScalar(value: unknown): string[] | undefined {
  return typeof value === "string" && value
    ? value.split(",").filter(Boolean)
    : undefined;
}

// The metadata a deletion audit line carries for the deleted row (#207).
// Kept out of the client contract: restore resolves it here, from the store's
// own record, rather than trusting replayed bytes.
interface DeletionMeta {
  tags?: string[];
  kw?: string[];
  issue?: string;
  status?: MemoryStatus;
  repo?: string;
  repoPath?: string;
}

function auditMeta(f: NonNullable<ReturnType<typeof parseLine>>): DeletionMeta {
  const tags = splitScalar(f.tags);
  const kw = splitScalar(f.kw);
  return {
    ...(tags ? { tags } : {}),
    ...(kw ? { kw } : {}),
    ...(typeof f.issue === "string" && f.issue ? { issue: f.issue } : {}),
    ...(f.status === "open" || f.status === "settled"
      ? { status: f.status }
      : {}),
    ...(typeof f.repo === "string" && f.repo ? { repo: f.repo } : {}),
    ...(typeof f.repoPath === "string" && f.repoPath
      ? { repoPath: f.repoPath }
      : {}),
  };
}

// Deleted entries live only in the audit log (their memory line was removed),
// so surface the recorded data + reason from deletions.logfmt.
async function deletedRows(): Promise<Row[]> {
  const lines = await readLines(deletionsFile());
  return lines
    .map((l) => parseLine(l))
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .map((f) => {
      const meta = auditMeta(f);
      return {
        ts: String(f.original_ts ?? f.ts ?? ""),
        type: String(f.type ?? ""),
        scope: String(f.scope ?? ""),
        content: String(f.content ?? ""),
        reason: String(f.reason ?? ""),
        ...meta,
        // #207: the operator must SEE that a deleted row was quarantined —
        // restoring it must not read as a way to release quarantine.
        ...(meta.tags
          ? { quarantined: isQuarantined({ tags: meta.tags }) }
          : {}),
      };
    });
}

// The authoritative record of what a deleted row carried, keyed by the deleted
// row's ts (#207). The LAST matching line wins: a row edited then deleted has
// its newest state last, and that is the state a restore re-adds. Lines
// written before #207 carry no metadata — the documented fallback.
async function deletionAuditFor(ts: string): Promise<DeletionMeta | undefined> {
  let found: DeletionMeta | undefined;
  for (const line of await readLines(deletionsFile())) {
    const f = parseLine(line);
    if (!f || f.original_ts !== ts) continue;
    found = auditMeta(f);
  }
  return found;
}

// Same record, keyed by the deleted row's identity instead of its ts (#207 F2).
// A restore request that omits ts is a legacy REQUEST, not a legacy record:
// if the audit carries a matching line, that line is still the authoritative
// copy of what the row carried, and resolving it here closes the laundering
// path (omitting ts must not restore a known quarantined row as injectable).
// Only when NO line matches — a client older than the viewer, or a row whose
// deletion predates the audit — does the route fall back to client replay.
async function deletionAuditByRow(
  type: string,
  scope: string,
  content: string,
): Promise<DeletionMeta | undefined> {
  let found: DeletionMeta | undefined;
  for (const line of await readLines(deletionsFile())) {
    const f = parseLine(line);
    if (!f || f.type !== type || f.scope !== scope || f.content !== content)
      continue;
    found = auditMeta(f);
  }
  return found;
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
  // No websocket routes, so the WebSocketData generic is undefined — the
  // default Bun.serve infers here. Was `any`, which hid the real shape.
  server: Server<undefined>;
  url: string;
  /** The minted token when exposure requires auth; null on a loopback-only bind. */
  token: string | null;
}

export async function startViewer(port: number = PORT): Promise<ViewerServer> {
  const page = await Bun.file(PAGE).text();
  // The same condition that used to only warn now switches authentication on:
  // if any allowed name can be reached from another machine, the token is
  // mandatory for every request, reads included (the store is the blast
  // radius of a read too). Loopback-only binds keep the token-free flow.
  const exposed = [...allowedHostnames()].some(
    (host) => !isLoopbackHostname(host),
  );
  const viewerToken = exposed ? await mintViewerToken() : null;
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
      if (viewerToken !== null) {
        // Bearer header or cookie on every path; the raw ?token= is accepted
        // on / only, as the bootstrap a human pastes once. The page's own
        // fetches are same-origin and carry the cookie, so the token never
        // has to appear in an API URL (or in a log line).
        const auth = req.headers.get("authorization");
        const bearer =
          auth && /^Bearer /i.test(auth) ? auth.slice(7).trim() : null;
        const cookie = cookieValue(req, TOKEN_COOKIE);
        const bootstrap =
          url.pathname === "/" ? url.searchParams.get("token") : null;
        // Validate every presentation instead of taking the first PRESENT
        // one (F2, #223 review): a stale cookie from before a supported
        // token regeneration must not shadow the freshly printed bootstrap
        // URL. A request with no valid credential is still refused.
        const accepted =
          (bearer !== null && tokenMatches(bearer, viewerToken)) ||
          (cookie !== null && tokenMatches(cookie, viewerToken)) ||
          (bootstrap !== null && tokenMatches(bootstrap, viewerToken));
        if (!accepted) return error("viewer authentication required", 401);
      }
      if (url.pathname === "/") {
        const headers: Record<string, string> = {
          ...SECURITY_HEADERS,
          "content-type": "text/html; charset=utf-8",
        };
        if (viewerToken !== null)
          headers["set-cookie"] =
            `${TOKEN_COOKIE}=${viewerToken}; HttpOnly; SameSite=Strict; Path=/`;
        return new Response(page, { headers });
      }
      if (req.method === "GET" && url.pathname === "/api/data") {
        return loaded().then(
          (d) => json(d),
          () => error("failed to load memory data"),
        );
      }
      return route(req, url).catch((e) =>
        error(e instanceof Error ? e.message : String(e)),
      );
    },
  });
  const bound = server.port ?? port;
  // Warn after binding; wildcard binds (0.0.0.0 and ::) are non-loopback too.
  if (exposed) console.warn(exposureWarning(tokenPath()));
  return {
    server,
    url: viewerToken
      ? `http://${HOST}:${bound}/?token=${viewerToken}`
      : `http://${HOST}:${bound}/`,
    token: viewerToken,
  };
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
      quarantined: isQuarantined(m),
      quarantinePatterns: quarantineReasons(m),
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
    if (url.pathname === "/api/edit")
      return parseWith(EditBody, body, editRoute);
    if (url.pathname === "/api/delete")
      return parseWith(DeleteBody, body, deleteRoute);
    if (url.pathname === "/api/block")
      return parseWith(BlockBody, body, blockRoute);
    if (url.pathname === "/api/unblock")
      return parseWith(UnblockBody, body, unblockRoute);
    if (url.pathname === "/api/release-quarantine") {
      return parseWith(ReleaseQuarantineBody, body, async ({ ts, reason }) =>
        json(await releaseQuarantinedMemory(ts, reason)),
      );
    }
    if (url.pathname === "/api/unreject")
      return parseWith(UnrejectBody, body, unrejectRoute);
    if (url.pathname === "/api/restore-entry")
      return parseWith(RestoreEntryBody, body, restoreEntryRoute);
    // /api/restore is deliberately NOT schema-parsed here: its name check is
    // basename + pinned-grammar CONTAINMENT, not a shape gate,
    // and its regression tests pin that behavior.
    if (url.pathname === "/api/restore")
      return restoreRoute(body as Record<string, unknown>);
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

async function deleteRoute(
  body: z.infer<typeof DeleteBody>,
): Promise<Response> {
  return json(await deleteMemory({ ts: body.ts, reason: body.reason }));
}

async function blockRoute(body: z.infer<typeof BlockBody>): Promise<Response> {
  return json({ ts: await blockMemory(body) });
}

async function unblockRoute(
  body: z.infer<typeof UnblockBody>,
): Promise<Response> {
  return json({ unblocked: await unblockMemory(body.ts) });
}

// The only way a rejection is ever lifted (#35). Human-only: the plugin exposes
// no tool for this, so a session whose write was refused cannot clear the
// refusal and re-submit the rejected value.
async function unrejectRoute(
  body: z.infer<typeof UnrejectBody>,
): Promise<Response> {
  return json({ unrejected: await unrejectMemory(body.ch) });
}

async function restoreEntryRoute(
  body: z.infer<typeof RestoreEntryBody>,
): Promise<Response> {
  await assertViewerWriteAllowed(body.content);
  // #207: every field that controls visibility or provenance is resolved from
  // the audit line itself — the store's own record — so a restore cannot
  // silently release quarantine (the quarantine tags come back with the row;
  // releasing it stays the deliberate, reason-required release-quarantine
  // action), cannot drop import provenance, and a client-forged repo stamp
  // loses to the authoritative one. With ts the lookup is by row identity, and
  // a ts that matches no audit line still resolves by type/scope/content
  // before any fallback: an unknown explicit ts is an unresolved identity, not
  // permission to replay (F2 residual). Without ts the lookup is by
  // type/scope/content directly. Either way, omitting or missing ts cannot
  // launder a KNOWN quarantined row back to injectable (F2). The client-replay
  // fallback (#129 origin stamp, no metadata) survives only for rows the audit
  // does not carry at all — a legacy record, not a legacy request.
  const src =
    (body.ts && (await deletionAuditFor(body.ts))) ||
    (await deletionAuditByRow(body.type, body.scope, body.content));
  const t = await appendMemory({
    type: body.type,
    scope: body.scope,
    content: body.content,
    ...(src
      ? {
          tags: src.tags,
          kw: src.kw,
          issue: src.issue,
          status: src.status,
          repo: src.repo,
          repoPath: src.repoPath,
        }
      : { repo: body.repo, repoPath: body.repoPath }),
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
  const res = await restoreSnapshot(
    join(snapshotDir(), name),
    memoryRoot(),
    "force",
  );
  return json({
    restored: res.target,
    safety: res.safety ?? null,
    rolledBack: res.concurrentAdded.length + res.concurrentChanged.length,
  });
}

if (import.meta.main) {
  startViewer(PORT).then(({ url }) => {
    console.log(
      `\nMemory Viewer: ${url}\n(snapshot+audit are mandatory on every edit/delete)`,
    );
  });
}
