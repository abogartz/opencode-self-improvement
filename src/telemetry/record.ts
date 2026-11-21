// Evidence log writer. One logfmt line per event, appended in hook order to
// ~/.config/opencode/memory/evidence/<date>.logfmt. Evidence is DATA: never
// injected into chat, and stored outside every repo.
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { evidenceDir } from "../core/config/paths.ts";
import { dateStr } from "../core/time.ts";
import { formatLine, IS_WINDOWS } from "../core/logfmt/format.ts";
import { appendLog } from "../core/logfmt/publish.ts";
import { tightenDirectory } from "../core/permissions.ts";
import {
  repoScope,
  sessionScope,
  type RepoScope,
} from "../identity/repokey.ts";
import { getCurrent } from "../core/state.ts";
import { redactSecrets } from "../store/secrets.ts";

export type EvidenceEvent = string;

// The ONLY path memory_evidence may read: a real calendar date in
// YYYY-MM-DD form, resolved INSIDE the evidence directory. The schema layer
// already refuses non-date strings at the boundary; this is the second door —
// impossible dates (2026-02-30, which Date would silently roll over) and
// symlinked day files must not hand out files outside the evidence dir.
// Returns null when the read must be refused; the forced .logfmt suffix is
// the primitive's residual bound either way.
export function evidenceFileFor(date?: string): string | null {
  const d = date ?? dateStr();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, day));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const dir = resolve(evidenceDir());
  const file = resolve(dir, `${d}.logfmt`);
  if (dirname(file) !== dir) return null; // containment, defense in depth
  if (existsSync(file)) {
    // A day file symlinked out of the store still has to land inside it.
    try {
      if (realpathSync(file) !== join(realpathSync(dir), `${d}.logfmt`))
        return null;
    } catch {
      return null; // an unreadable link is not a file we will follow
    }
  }
  return file;
}

// Credential scrub at the evidence WRITE boundary. Evidence fields routinely
// carry caller-authored prose (gate reasons, block reasons, review notes) and
// tool-derived summaries; a recognized credential must not persist in the
// durable log no matter which line carried it. redactSecrets is a
// no-op on ordinary text (ids, hashes, paths, counts).
function scrubFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === "string" ? redactSecrets(value) : value;
  }
  return out;
}

// Immutable operation attribution, captured before the caller's first await.
// Null scope is significant: a named-unresolved session must stay private.
export interface EvidenceContext {
  readonly sid: string;
  readonly call: string | undefined;
  readonly scope: Readonly<RepoScope> | null;
}

export function captureEvidenceContext(sessionID?: string): EvidenceContext {
  const cur = getCurrent();
  // An explicitly threaded session outranks the ambient one: gate-authored
  // lines must name the session the gate runs FOR, not whichever setCurrent
  // fired last during the gate's own awaits. When the two disagree,
  // the ambient call belongs to the OTHER session's flow, so it is dropped
  // rather than borrowed. With sessionID undefined this captures the ambient
  // session and call at entry by design (maintenance/direct callers). An
  // explicit "?" keeps the ambient call only when cur.sid is also "?";
  // otherwise it stays absent, even if a later setCurrent supplies a call.
  // Normal tool hooks setCurrent before execute; this snapshot never guesses
  // a missing operation call from a later hook. See for identity context.
  const sid = sessionID ?? cur.sid;
  const call =
    sessionID !== undefined && sessionID !== cur.sid ? undefined : cur.call;
  // Read-side partitioning of the shared log (the rule, applied to
  // evidence; the re-review closed the last two gaps in it). A NAMED session
  // is stamped from its OWN resolved scope only — the module scope is never
  // the fallback here: in a process that loaded several plugin instances it
  // belongs to whoever set up LAST, and A's evidence must not live in B's
  // repository. A named session whose repository is unresolvable writes an
  // UNSTAMPED line that stays private to that session (memory.ts
  // evidenceVisibleTo pairs with this choice): "unknown" is never
  // "everything", and it is never somebody else's repo either. Only a
  // genuinely session-less line — out-of-plugin maintenance, viewer, CLI —
  // takes the process scope, and unstamped session-less lines (legacy, or a
  // scope-less process) keep their historical global reading.
  const named = typeof sid === "string" && sid !== "" && sid !== "?";
  const scope = named ? sessionScope(sid) : repoScope();
  return Object.freeze({
    sid,
    call,
    scope: scope ? Object.freeze({ ...scope }) : null,
  });
}

// evidence ABOUT a specific row inherits the ROW's repository, not the
// writing process's. The viewer is an admin entry point with no repository of
// its own, so its ambient context stamps nothing — and evidenceVisibleTo
// reads an unstamped, sid-less line as GLOBAL. Without this, editing or
// deleting another repository's private row from the viewer exposed the
// operator's reason and row ids to every other repository's memory_evidence.
// Callers that hold the target row spread these fields into record(): a
// private stamp is carried verbatim; a global (or legacy unstamped) target
// becomes an explicit `repo=global` line — same visibility as before, now
// honest on the line itself. The fields spread last in record(), so they
// outrank any ambient stamp even in a process that loaded a plugin. The
// global branch returns an EXPLICIT `repoPath: undefined` (N1 on): the
// spread must also clear an ambient repoPath, or a shared process that
// happens to hold repo B's scope would leave B's path on a globally readable
// line about a global row. formatLine drops undefined values, so the key
// never lands on disk — it only cancels the ambient one in the merge.
export function targetRepoFields(target: {
  repo?: string;
  repoPath?: string;
}): { repo: string; repoPath?: string } {
  return target.repo && target.repo !== "global"
    ? { repo: target.repo, repoPath: target.repoPath }
    : { repo: "global", repoPath: undefined };
}

// Builds one evidence line exactly as `record` would, synchronously. Split out
// so `recordSync` can flush a line without yielding the event loop — the
// capture-start receipt must land before the host can cut the handler, and the
// async `appendLog` path (mkdir + open + chmod + stat + append + close) yields
// several times, which measurably shrinks the window the capture model call has
// to finish on a fast-exiting `opencode run`.
function buildEvidenceLine(
  ev: EvidenceEvent,
  fields: Record<string, unknown>,
  includeContext: boolean,
  sessionID?: string,
  context?: EvidenceContext,
): string {
  const { sid, call, scope } = context ?? captureEvidenceContext(sessionID);
  return formatLine({
    ev,
    ts: new Date().toISOString(),
    // A captured unresolved owner still needs a privacy label: without sid or
    // repo, evidenceVisibleTo treats a line as legacy/global. Suppress call
    // metadata as requested, but never turn an explicit private owner global.
    ...(includeContext
      ? { sid, call }
      : context && !scope && sid && sid !== "?"
        ? { sid }
        : {}),
    ...(scope ? { repo: scope.key, repoPath: scope.path } : {}),
    ...scrubFields(fields),
  });
}

export async function record(
  ev: EvidenceEvent,
  fields: Record<string, unknown> = {},
  includeContext = true,
  sessionID?: string,
  context?: EvidenceContext,
): Promise<void> {
  const line = buildEvidenceLine(
    ev,
    fields,
    includeContext,
    sessionID,
    context,
  );
  await appendLog(join(evidenceDir(), `${dateStr()}.logfmt`), line);
}

/**
 * Synchronous counterpart to `record`. Use ONLY where a write must land before
 * the process can be cut — currently the capture-start receipt. It does not
 * yield, so the host's exit logic (also on the event loop) cannot preempt it,
 * and it leaves the model call's teardown window intact. Same line shape and
 * redaction as `record`, and the same file protections as `appendLog`: the
 * directory is tightened, the file is opened `O_NOFOLLOW` and its mode is
 * narrowed to `0o600` before the append.
 */
export function recordSync(
  ev: EvidenceEvent,
  fields: Record<string, unknown> = {},
  includeContext = true,
  sessionID?: string,
  context?: EvidenceContext,
): void {
  const dir = evidenceDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  tightenDirectory(dir);
  const line = buildEvidenceLine(
    ev,
    fields,
    includeContext,
    sessionID,
    context,
  );
  const next = line.endsWith("\n") ? line : `${line}\n`;
  const file = join(dir, `${dateStr()}.logfmt`);
  const fd = openSync(
    file,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (!IS_WINDOWS) fchmodSync(fd, fstatSync(fd).mode & 0o600);
    appendFileSync(fd, next);
  } finally {
    closeSync(fd);
  }
}

export function contentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

export function chainId(): string {
  return createHash("sha1")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
}

/**
 * One capture decision, in both directions. `lagMs` is the wall-clock distance
 * from the last message of the transcript to the moment the capture model was
 * asked — the number asks for ("how stale is a capture?"). Negative and
 * missing values are dropped rather than guessed: a capture with no observed
 * message time has no lag, and inventing 0 would pull p50 toward "instant".
 */
export async function recordCaptureLag(
  session: string,
  lagMs: number | null,
  outcome: string,
  context?: EvidenceContext,
  // the model the capture actually ran on, so a cost audit can join a
  // lag line to the model that spent the tokens. Optional: metric tests and
  // any caller without a resolved model keep the old shape.
  model?: string,
): Promise<void> {
  await record(
    "capture_lag",
    {
      session,
      ...(lagMs !== null && Number.isFinite(lagMs) && lagMs >= 0
        ? { lag: Math.round(lagMs) }
        : {}),
      outcome,
      ...(model ? { model } : {}),
    },
    false,
    session,
    context,
  );
}

export async function recordWriteBlocked(
  gate: number,
  reason: string,
  flags: string[],
  chain?: string,
  sessionID?: string,
  context?: EvidenceContext,
): Promise<void> {
  await record(
    "write_blocked",
    {
      gate,
      reason,
      flags: `[${flags.join(",")}]`,
      ...(chain ? { chain } : {}),
    },
    true,
    sessionID,
    context,
  );
}
