// Per-setup session binding and caller context. Adapters provide normalized
// identities and directory lookups; ownership and lookup ordering stay here.
import type { SessionDirectories, ToolCallContext } from "../host/contracts.ts";
import type { GateContext } from "../gate/gate.ts";
import { captureEvidenceContext, record } from "../telemetry/record.ts";
import { unresolvedWriteMessage } from "../store/files/append.ts";
import { readerFromSid } from "../store/model/visibility.ts";
import { getCurrent } from "../core/state.ts";
import { SESSION_CAP, SessionLru } from "../core/lru.ts";
import {
  writeEvidence,
  hasGateCheck,
  hasEngagement,
} from "../capture/triggers.ts";
import {
  bindSessionProvisional,
  writeTarget,
  sessionDir,
  sessionDirFirm,
  rememberSessionDir,
} from "./repokey.ts";
export function createSessionContext(
  directories: SessionDirectories,
  {
    instanceDir,
    liveRoot,
  }: { instanceDir: string | undefined; liveRoot: string },
) {
  const gateContext = (sid?: string): GateContext => {
    // Every session-scoped member resolves for the CALLER's session when it
    // knows one: capture awaits a model call between setCurrent and
    // persistence, and on a multi-session server the global current moves
    // during that await. Falling back to getCurrent() is exactly today's
    // behavior for callers whose current IS their session (tool hooks).
    const bound = sid ?? getCurrent().sid;
    return {
      sessionID: sid,
      reader: readerFromSid(sid),
      writeAt: writeTarget(bound),
      evidenceContext: captureEvidenceContext(sid),
      // NOTE (re-review): this one lookup is intentionally NON-firm — a
      // provisional binding may supply the gate's verification TREE. The
      // tree is where a referenced file is checked to exist, not who the
      // caller is: "as far as the flow can know" is the right confidence
      // level, and a wrong guess fails a code-reference gate loudly rather
      // than leaking across repositories. Identity itself never resolves
      // through here (readers and stamps use the firm-or-provisional split
      // in repokey/memory); do not mistake this for one.
      liveRoot: sessionDir(bound) ?? liveRoot,
      ...writeEvidence(bound),
      hasGateCheck: hasGateCheck(bound),
      hasEngagement: hasEngagement(bound),
    };
  };

  // A durable write needs an OWNER. Reads already fail closed for a
  // session whose repository never resolved — it sees global rows and nothing
  // else — so such a session may not write either: the alternatives were the
  // last setup's repository or an unstamped (hence global) row. This answers
  // at the entry, where the model can be told what to do, and records the
  // refusal so "why is nothing stored" is answerable from memory_evidence.
  // appendMemory throws the same rule at the choke point; the two share one
  // message so they cannot drift.
  const ownerlessWriter = (sid: string | undefined): string | null => {
    const target = writeTarget(sid);
    return target.ok ? null : target.sid;
  };

  const refuseOwnerlessWrite = async (
    sid: string,
    op: string,
  ): Promise<{ content: string }> => {
    await record("write_refused", { op }, true, sid);
    return { content: unresolvedWriteMessage(sid) };
  };

  // Identity of a tool call, captured SYNCHRONOUSLY at the tool's entry —
  // the first await of the call comes after this. Adapters supply per-call
  // identity. A legacy caller may omit it only when the before-tool hook set
  // the ambient current immediately before entry, with no intervening await.
  // Never re-read the global after an await to learn who is calling.
  const toolIds = (
    context?: ToolCallContext,
  ): { sid: string; call: string } => {
    const { sessionID: fromCtx, callID: call } = context ?? {};
    // Entry binding: a session this instance has never seen is resolved to
    // THIS workspace (provisional — a firm event/API identity still
    // replaces it), so the tool's reader partitions by the repository the
    // call reached, not by the last setup's module scope.
    if (fromCtx && fromCtx !== "?") {
      bindSessionProvisional(fromCtx, instanceDir);
    }
    return {
      sid: fromCtx ?? getCurrent().sid,
      call: call ?? getCurrent().call,
    };
  };

  // Identity-event race backstop: a resumed session's FIRST turn can write
  // before the subscription has delivered its execution.started, and the
  // module-scope fallback is the last setup instance — possibly another
  // workspace. Bind once from the session context API for unmapped sids —
  // but note host 2.1.4 sends message payloads WITHOUT any location field,
  // so this path is a legacy-shape best-effort; the session-row fallback
  // below is what actually resolves serve-host sessions.
  // One-shot: never overwrites an event-bound entry.
  const messageBindings = new Map<string, Promise<void>>();
  async function bindSessionFromMessages(
    sid: string | undefined,
  ): Promise<void> {
    if (!sid || sid === "?" || sessionDirFirm(sid)) return;
    const pending = messageBindings.get(sid);
    if (pending) return pending;
    // Publish the promise before invoking the host: concurrent callers must
    // await this identity source rather than fall through to a provisional one.
    const binding = Promise.resolve().then(async () => {
      try {
        const dir = await directories.fromTranscript?.(sid);
        if (dir !== undefined) rememberSessionDir(sid, dir);
      } catch {
        // no context access or host error: the event stream still binds later
      }
    });
    messageBindings.set(sid, binding);
    try {
      await binding;
    } finally {
      messageBindings.delete(sid);
    }
  }

  // Serve-host reality (recorded on 2.1.4 `serve --service`): the plugin
  // instance loads AFTER the session was created, so `session.created` — the
  // only event carrying a location — is never delivered; `execution.started`
  // arrives with just {sessionID}. The session ROW is the remaining source
  // of truth: the host's session get returns `location.directory`. One
  // lookup per session; a miss is remembered so a host without the API is
  // not re-asked on every turn (bounded LRU, same cap as the scope cache).
  const apiBindTried = new Set<string>();
  const apiBindOrder = new SessionLru(SESSION_CAP, (evicted) =>
    apiBindTried.delete(evicted),
  );
  const apiBindings = new Map<string, Promise<void>>();
  async function bindSessionFromApi(sid: string | undefined): Promise<void> {
    if (!sid || sid === "?" || sessionDirFirm(sid)) return;
    // An event may already be fetching this row. Join it before consulting
    // the completed-attempt cache, which also records attempts still in flight.
    const pending = apiBindings.get(sid);
    if (pending) return pending;
    if (apiBindTried.has(sid)) return;
    apiBindTried.add(sid);
    apiBindOrder.touch(sid);
    const binding = Promise.resolve().then(async () => {
      try {
        const dir = await directories.fromSession?.(sid);
        if (dir !== undefined) rememberSessionDir(sid, dir);
      } catch {
        // no session.get on this host (or unknown session): stay unbound
      }
    });
    apiBindings.set(sid, binding);
    try {
      await binding;
    } finally {
      apiBindings.delete(sid);
    }
  }

  // Identity must resolve BEFORE a row is stamped or a read is partitioned:
  // try the (legacy) message payloads, then the session row. A session the
  // host cannot describe (fresh, or a host without the lookup) is bound to
  // THIS instance's workspace — the caller's repository as the flow knows
  // it, and strictly better than an unbound read inheriting the module
  // scope of whoever loaded last (multi-setup residue).
  async function bindSessionIdentity(sid: string | undefined): Promise<void> {
    if (!sid || sid === "?" || sessionDirFirm(sid)) return;
    await bindSessionFromMessages(sid);
    if (!sessionDirFirm(sid)) await bindSessionFromApi(sid);
    bindSessionProvisional(sid, instanceDir);
  }

  return {
    gateContext,
    ownerlessWriter,
    refuseOwnerlessWrite,
    toolIds,
    bindSessionFromApi,
    bindSessionIdentity,
  };
}
