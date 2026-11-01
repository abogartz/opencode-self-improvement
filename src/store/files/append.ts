// append — split from src/memory.ts (#168 domain restructure). Declaration bodies are unchanged.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { memoryRoot } from "../../core/config/paths.ts"
import { dateStr } from "../../core/time.ts";
import { writeTarget } from "../../identity/repokey.ts";
import { getCurrent } from "../../core/state.ts";
import { formatLine, parseLine } from "../../core/logfmt/format.ts"
import { fileIdentity, writeAtomic } from "../../core/logfmt/publish.ts";
import { withStoreLock, LOCK_WRITE } from "../lock.ts";
import { containsSecret, redactSecrets } from "../secrets.ts";
import { flattenMemoryText } from "../sanitize.ts";
import { MAX_CONTENT_CHARS, type MemoryStatus, normalizeKeywords } from "../model/memory.ts";

export interface AppendMemoryInput {
  type: string;
  scope: string;
  content: string;
  issue?: string;
  tags?: string[];
  /** Retrieval keywords (#40); normalised and capped by appendMemory. */
  kw?: string[];
  status?: MemoryStatus;
  // "global" for explicit cross-project writes; imports may carry a validated
  // same-repo origin stamp (see portable.ts). Any missing value is resolved by
  // appendMemory against the live repo scope.
  repo?: string;
  repoPath?: string;
  // Which session the write belongs to, when the caller knows it (the gate
  // threads it from GateContext, #116). Preferred over the ambient current.
  sessionID?: string;
}

// ts values already in `file`. An appended row's ts is "now", so the only rows
// it can collide with are ones this same file received in the same millisecond;
// scanning just it keeps the locked section to one read of one file. (A row
// hand-placed with today's ts in another day's file is outside this promise.)
function existingTs(text: string): Set<string> {
  const set = new Set<string>();
  for (const line of text.split("\n")) {
    const f = parseLine(line);
    if (f && typeof f.ts === "string") set.add(f.ts);
  }
  return set;
}

// #152: the store's answer to a write whose owner it cannot determine. Thrown
// from the one place that knows what an owner is (the stamp resolution below),
// so no caller — gate, import, capture, or a future one — can quietly persist
// an ownerless row. `unresolvedWriteMessage` is the same text the model-facing
// tools return, kept here so the two can never drift.
export function unresolvedWriteMessage(sid: string): string {
  return (
    `Write refused: session ${sid} has no resolvable repository, so nothing was stored. ` +
    `A memory with no owner must not be stamped into another repository or published as a ` +
    `global row. Retry from a session in the project you mean, or pass global:true for a ` +
    `deliberate cross-project memory.`
  );
}

export class UnresolvedWriterError extends Error {
  /** The named-but-unresolved session whose write was refused. */
  sid: string;
  constructor(sid: string) {
    super(unresolvedWriteMessage(sid));
    this.name = "UnresolvedWriterError";
    this.sid = sid;
  }
}

// Append a durable memory. GATE-4 promotions and the viewer's edit/restore-entry
// paths all call this single write choke point.
export async function appendMemory(input: AppendMemoryInput): Promise<string> {
  // Absolute floor: every write SHOULD arrive through the gate,
  // which rejects invalid input politely; viewer writes do not, so enforce the
  // same storage rules here before anything reaches disk.
  if (typeof input.content !== "string") throw new Error("memory content must be a string");
  if (input.content.length > MAX_CONTENT_CHARS) {
    throw new Error(`memory content exceeds ${MAX_CONTENT_CHARS} chars (${input.content.length})`);
  }
  for (const [field, value] of [
    ["type", input.type],
    ["scope", input.scope],
    ["issue", input.issue],
  ] as const) {
    if (value !== undefined && flattenMemoryText(value) !== value) {
      throw new Error(`memory ${field} must not contain control characters`);
    }
  }
  if (input.tags?.some((tag) => flattenMemoryText(tag) !== tag)) {
    throw new Error("memory tags must not contain control characters");
  }
  // Keywords are indexed, never rendered, but they still live on the row's
  // single line, so the same control-character floor applies.
  if (input.kw?.some((k) => typeof k !== "string" || flattenMemoryText(k) !== k)) {
    throw new Error("memory keywords must not contain control characters");
  }
  const credentialMetadata = [
    containsSecret(input.scope) ? "scope" : undefined,
    input.tags?.some(containsSecret) ? "tags" : undefined,
    input.kw?.some(containsSecret) ? "kw" : undefined,
    containsSecret(input.issue) ? "issue" : undefined,
  ].filter((field): field is string => field !== undefined);
  if (credentialMetadata.length) {
    throw new Error(
      `memory metadata contains credential-shaped value in: ${credentialMetadata.join(", ")}`,
    );
  }
  const content = redactSecrets(input.content);
  // Repo stamp at the single write choke point: gated writes plus viewer edits
  // and restore-entry writes all pass through here. Explicit "global" survives;
  // an unscoped process (viewer) stamps nothing = global. Session identity wins
  // over the module scope so a server hosting several workspaces stamps the
  // writing session's repo.
  let repo = input.repo;
  let repoPath = input.repoPath;
  if (repo === undefined) {
    // The caller's session when it named one: capture awaits a model call, and
    // the last setCurrent before persistence may belong to another session
    // entirely (#116). Unnamed writers (tools, viewer, restore) keep the
    // ambient binding.
    //
    // A NAMED session that never resolved a repository is not an unnamed one
    // (#152): falling back to the module scope stamped its rows into whatever
    // workspace set up last, and with no module scope at all it stamped nothing
    // — which every reader calls global. Both outcomes publish private content
    // somewhere its owner can no longer see it, so the store refuses the write
    // instead of guessing an owner. Tools answer with this message before the
    // gate runs; throwing here is what covers every caller, including ones that
    // reach the store without a tool.
    const target = writeTarget(input.sessionID ?? getCurrent().sid);
    if (!target.ok) throw new UnresolvedWriterError(target.sid);
    if (target.scope) {
      repo = target.scope.key;
      repoPath = target.scope.path;
    }
  }
  // Day file chosen before the lock (it IS the lock key). A ts bumped across
  // midnight therefore lands under the previous day's name; readers glob every
  // file and decay compares ts values, so the grouping is cosmetic.
  const file = join(memoryRoot(), `${dateStr()}.logfmt`);
  // Locked end to end: seeding ts from a scan another process can race yields
  // two rows with the same identity, and an append that lands inside someone
  // else's whole-file rewrite is simply not there afterwards.
  return withStoreLock(file, async () => {
    const since = await fileIdentity(file);
    let prior = "";
    try { prior = await readFile(file, "utf8"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    const taken = existingTs(prior);
    let ts = new Date().toISOString();
    let guard = 0;
    while (taken.has(ts) && guard++ < 1000) {
      ts = new Date(new Date(ts).getTime() + 1).toISOString();
    }
    const kw = normalizeKeywords(input.kw);
    const line = formatLine({
      ts,
      type: input.type,
      scope: input.scope,
      content,
      issue: input.issue,
      tags: input.tags?.length ? input.tags.join(",") : undefined,
      kw: kw?.join(","),
      status: input.status,
      repo,
      repoPath,
    });
    // A lock excludes writers, not readers: an O_APPEND read can end mid-row.
    // Publish the complete day file using the read already needed for IDs.
    // This costs a whole-file write and can refuse on Windows reader handles;
    // the old destination remains intact if publication fails (#198).
    await writeAtomic(file, prior + (prior && !prior.endsWith("\n") ? "\n" : "") + line + "\n", since);
    return ts;
  }, LOCK_WRITE);
}
