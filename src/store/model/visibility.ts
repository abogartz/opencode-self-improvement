// visibility — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { repoScopeFor, sessionScope, type RepoScope } from "../../identity/repokey.ts";
import { getCurrent } from "../../core/state.ts";
import { parseLine } from "../../core/logfmt/format.ts";
import { prune } from "../files/prune.ts";
import { type Memory } from "./memory.ts";

// --- repo visibility ---------------------------------------------------------
// A READER is an immutable caller identity, resolved once at the entry of a
// flow (a hook, a tool call, a viewer route) and carried through every await
// in that flow. Resolution must NOT be deferred to filter time: the module
// global current moves whenever another session's hook or tool dispatches, and
// a store read awaits filesystem I/O — filtering after the await with the
// ambient identity injects the OTHER session's repo (#127).
//
//   repo        — the caller's session resolved a repository (its own when
//                 bound; the setup location for an unbound session in a
//                 single-workspace plugin, exactly the historical semantics).
//   global-only — a plugin flow whose caller identity names no repository:
//                 explicit/legacy global rows ONLY. This is the fail-closed
//                 answer for an unbound session on a serve host; "unknown"
//                 is never "everything".
//   admin       — explicit all-repositories access: the standalone viewer and
//                 out-of-plugin maintenance callers. Administrative breadth is
//                 a property of the entry point, never of a missing session.
export type Reader =
  | { kind: "repo"; scope: RepoScope }
  | { kind: "global-only" }
  | { kind: "admin" };

/** Explicit all-repositories identity (viewer routes, CLI maintenance). */
export const ADMIN_READER: Reader = { kind: "admin" };

// Reader for a plugin-session flow, resolved from the caller's OWN session id
// captured synchronously at flow entry. Bound session → its repo; unbound →
// global-only. The module scope is NOT a fallback here: in a process that
// loaded more than one plugin instance it belongs to whoever set up LAST,
// which is another workspace (#127's multi-setup gap). Plugin flows bind an
// unbound caller to their OWN setup location at entry (index.ts), so ordinary
// single-workspace sessions resolve through the session map, never here.
export function readerForSession(sid?: unknown): Reader {
  const scope = sessionScope(sid);
  return scope ? { kind: "repo", scope } : { kind: "global-only" };
}

// The historical AMBIENT reader: live session, then module scope, and no
// scope at all reads as unpartitioned. Correct only for out-of-plugin callers
// (viewer, scripts, unit tests) with no concurrent sessions; model-facing
// plugin paths carry a Reader instead of using this.
export function readerForAmbient(): Reader {
  const scope = repoScopeFor(getCurrent().sid);
  return scope ? { kind: "repo", scope } : { kind: "admin" };
}

// Ambient-style entry points take an optional sid: a real session id resolves
// fail-closed through readerForSession; "?" or absent keeps legacy semantics.
export function readerFromSid(sid?: unknown): Reader {
  return typeof sid === "string" && sid !== "" && sid !== "?"
    ? readerForSession(sid)
    : readerForAmbient();
}

// The ONLY repo filter every read path uses (injection sinks, recall, list,
// update targeting, prune, decay, gate scope reads). A row is visible when it
// is global (explicit marker OR no stamp — legacy rows and writes by
// processes with no scope, e.g. the viewer), or was written in the reader's
// repo. Keeping it one predicate is what stops the filtering from drifting
// between entry points.
export function isVisibleTo(m: Pick<Memory, "repo" | "repoPath">, reader: Reader): boolean {
  if (reader.kind === "admin") return true;
  if (!m.repo || m.repo === "global") return true;
  if (reader.kind === "global-only") return false;
  return m.repo === reader.scope.key || (!!m.repoPath && m.repoPath === reader.scope.path);
}

export function visibleTo(mems: Memory[], reader: Reader): Memory[] {
  return mems.filter((m) => isVisibleTo(m, reader));
}

// The day-file twin of isVisibleTo for whole-file paths (undo/restore) that
// work on raw logfmt lines instead of parsed rows: the SAME predicate, with the
// rows' rule that a line with no stamp is a legacy row, not a private one —
// which is exactly the rule the evidence lines do NOT share, and the reason
// these are not one function. An unparseable line has no stamp, so it reads
// legacy-global rather than silently vanishing under a restore.
export function lineVisibleTo(line: string, reader: Reader): boolean {
  if (reader.kind === "admin") return true;
  const fields = parseLine(line);
  return isVisibleTo(
    {
      repo: typeof fields?.repo === "string" ? fields.repo : undefined,
      repoPath: typeof fields?.repoPath === "string" ? fields.repoPath : undefined,
    },
    reader,
  );
}

// The evidence-line twin of isVisibleTo, plus the one rule rows do not need:
// a missing stamp is NOT the same as a global marker. An explicitly
// `repo=global` line is global, and a line with no stamp AND no named
// session (legacy, or an out-of-plugin maintenance write) keeps its
// historical global reading. But a line a NAMED session wrote while its
// repository was unresolvable (evidence.ts) belongs to that session alone —
// visible back to the same session and to the admin surface, never to a
// stranger's memory_evidence. `callerSid` is the reading session's own id
// captured at flow entry; without it the private branch can only fail
// closed (admin sees all, everyone else does not).
export function evidenceVisibleTo(
  fields: Record<string, unknown>,
  reader: Reader,
  callerSid?: unknown,
): boolean {
  if (reader.kind === "admin") return true;
  const repo = fields.repo;
  if (typeof repo === "string" && repo !== "") {
    if (repo === "global") return true;
    if (reader.kind === "global-only") return false;
    const repoPath = fields.repoPath;
    return (
      repo === reader.scope.key ||
      (typeof repoPath === "string" && !!repoPath && repoPath === reader.scope.path)
    );
  }
  const sid = fields.sid;
  if (typeof sid === "string" && sid !== "" && sid !== "?") {
    return typeof callerSid === "string" && callerSid === sid;
  }
  return true;
}

// Ambient (out-of-plugin) convenience: resolves the reader at CALL time.
// Plugin paths must pass an explicit Reader/sid instead of relying on this.
export function isVisibleHere(m: Memory): boolean {
  return isVisibleTo(m, readerForAmbient());
}

// Rows visible to the current process (active filtering stays with callers).
export function visibleHere(mems: Memory[]): Memory[] {
  return mems.filter(isVisibleHere);
}
