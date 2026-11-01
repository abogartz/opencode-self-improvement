// Repo identity for memory scoping. A server process can host sessions from
// several workspaces, and setup() can run before the host attaches a session
// location — so identity is resolved PER SESSION from the event stream and
// falls back to the module scope (which itself may be null, never a guessed
// cwd). Every store write stamps it; every model-facing read filters by it.
//
// Two keys, both cheap, with opposite failure modes:
//   key  — sha1 of the normalized origin URL: survives re-clone, moves, and
//          export/import to another machine. Absent when the repo has no
//          origin (fresh or remote-less): sha1 of the NORMALIZED resolved
//          path instead, so repo= is always a bare token — a raw path with
//          a space gets logfmt-quoted, which breaks naive field extraction
//          and can't be hash-compared (#92). path stays the human-readable
//          secondary, so rows stamped before the hash keep matching.
// Rows carry no stamp when their writer had no scope (viewer process,
// tests) and legacy rows predate the field: both read as GLOBAL — visible
// everywhere — which keeps every upgrade non-breaking.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

export interface RepoScope {
  key: string;
  path: string;
}

let current: RepoScope | null = null;

export function setRepoScope(scope: RepoScope | null): void {
  current = scope;
}

export function repoScope(): RepoScope | null {
  return current;
}

// git@github.com:Owner/Repo.git / https://GitHub.com/owner/repo/ ->
// github.com/owner/repo — the same repo must hash identically whichever
// remote form (and case) the clone used.
export function normalizeRemote(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^(?:https?:\/\/|ssh:\/\/|git:\/\/)/, "");
  u = u.replace(/^git@/, "");
  u = u.replace(/\/$/, "");
  u = u.replace(/\.git$/, "");
  // scp-style "github.com:owner/repo" -> slash form, so every transport of
  // one repo hashes to one id. (First colon only; URL ports in remotes are
  // rarer than the scp form and merely produce a stable different id.)
  u = u.replace(":", "/");
  return u;
}

function git(args: string[], cwd: string): string | null {
  try {
    const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "ignore" });
    const out = p.stdout?.toString().trim();
    return p.exitCode === 0 && out ? out : null;
  } catch {
    return null;
  }
}

// Normalize a directory for hashing: symlinks, junctions, and Windows 8.3
// aliases collapse to the real path (realpath), separators unify to "/",
// a trailing separator disappears, and case folds ONLY on the
// case-insensitive filesystems (win32/darwin) where two spellings are the
// same directory — Linux folds nothing, there "Foo" and "foo" are two dirs.
export function normalizeDirPath(p: string): string {
  let r = p;
  try {
    r = realpathSync(r);
  } catch {
    // deleted/unreadable mid-resolve: hash the given spelling rather than throw
  }
  r = r.replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32" || process.platform === "darwin") r = r.toLowerCase();
  return r || "/";
}

// Resolve the current repo from any start dir (never throws; a non-git dir
// simply scopes by the hash of its own normalized path).
export function resolveRepo(startDir: string): RepoScope {
  const path = git(["git", "rev-parse", "--show-toplevel"], startDir) ?? startDir;
  const remote = git(["git", "remote", "get-url", "origin"], path);
  const key = remote
    ? createHash("sha1").update(normalizeRemote(remote)).digest("hex").slice(0, 12)
    : createHash("sha1").update(normalizeDirPath(path)).digest("hex").slice(0, 12);
  return { key, path };
}

// --- per-session identity -----------------------------------------------------
// Learned from session events (created / execution.started / moved). Bounded:
// a long-lived server must not grow this with every session ever seen.
const SESSION_CAP = 64;
const byDir = new Map<string, RepoScope>();
const bySession = new Map<string, { dir: string; scope: RepoScope }>();

function scopeForDir(dir: string): RepoScope {
  let s = byDir.get(dir);
  if (!s) {
    s = resolveRepo(dir);
    byDir.set(dir, s);
  }
  return s;
}

export function rememberSessionDir(sid: string, dir: string): void {
  provisional.delete(sid);
  const prev = bySession.get(sid);
  if (prev && prev.dir === dir) return;
  bySession.set(sid, { dir, scope: scopeForDir(dir) });
  while (bySession.size > SESSION_CAP) bySession.delete(bySession.keys().next().value as string);
}

// A binding learned from a fallback, not from the session's own identity. A
// plugin instance may resolve an UNKNOWN session to its own setup location —
// the caller reached this instance, so this workspace is the caller's repo as
// far as the flow can know (never the module scope, which belongs to whoever
// loaded LAST, #127's residual multi-setup gap). Real identity from the event
// stream or the session-row API always replaces a provisional binding.
const provisional = new Set<string>();

export function bindSessionProvisional(sid: string, dir: string | undefined): void {
  if (!sid || sid === "?" || !dir || bySession.has(sid)) return;
  rememberSessionDir(sid, dir);
  provisional.add(sid);
}

// sessionDir, but only when the binding is FIRM (learned from the session's
// own events or the session row) — the guard for lookups that must not stop
// early on a provisional guess.
export function sessionDirFirm(sid?: string): string | undefined {
  if (sid && provisional.has(sid)) return undefined;
  return sessionDir(sid);
}

export function sessionDir(sid?: string): string | undefined {
  if (!sid || sid === "?") return undefined;
  return bySession.get(sid)?.dir;
}

// The scope a write/read belongs to: the session's when known, else the
// module scope (null = unscoped process = global rows).
export function repoScopeFor(sid?: string): RepoScope | null {
  if (sid && sid !== "?") {
    const e = bySession.get(sid);
    if (e) return e.scope;
  }
  return current;
}

// The scope of a session bound from the event stream / session-row API, with
// NO module-scope fallback. Read paths that carry a caller's session identity
// resolve through this: an unbound session must fail closed to global rows
// (#127), never inherit a module scope that belongs to another workspace (or
// is null, which the ambient reader has always read as "everything").
export function sessionScope(sid?: unknown): RepoScope | undefined {
  if (!isNamedSid(sid)) return undefined;
  return bySession.get(sid)?.scope;
}

/** Did the host actually name a session? ("?" and absent mean nobody.) */
export function isNamedSid(sid: unknown): sid is string {
  return typeof sid === "string" && sid !== "" && sid !== "?";
}

// The repository a DURABLE WRITE belongs to (#152) — the write-side twin of
// sessionScope, and deliberately not `repoScopeFor`: that helper's last resort
// is the module scope, which is the identity of whoever called setup() LAST.
// Reading with the wrong owner can only ever show too little (an unbound
// session reads global rows and nothing else), but writing with the wrong owner
// MOVES private content into a repository that cannot recall where it came
// from — and a null module scope turns the same write into an unstamped, hence
// global, row that every other project then reads. So an identity the host
// named but never resolved has NO write target: `ok:false`, which callers must
// refuse rather than downgrade. A caller that names nobody (viewer process,
// restore, scripts, unit tests) keeps the historical module-scope answer,
// including "no scope at all" — that is the deliberate admin path.
export type WriteTarget =
  | { ok: true; scope: RepoScope | null }
  | { ok: false; sid: string };

export function writeTarget(sid?: unknown): WriteTarget {
  if (!isNamedSid(sid)) return { ok: true, scope: current };
  const scope = sessionScope(sid);
  return scope ? { ok: true, scope } : { ok: false, sid };
}

export function resetSessionScopes(): void {
  bySession.clear();
  byDir.clear();
  provisional.clear();
}
