// run — split from src/init.ts (#168 domain restructure). Declaration bodies are unchanged.
// Repository init: ensure the codebase-memory graph exists for this repo and
// re-derive build/test command memories through the write gate. Deterministic
// (no model calls): the graph binary is spawned one-shot via `cli`, manifests
// are parsed locally, and every write goes through the 4-gate pipeline with the
// `trusted` flag (plugin-authored bookkeeping, not model claims). Degrades
// gracefully when the binary or git is absent, so install-from-scratch still
// writes script memories.
import { basename } from "node:path";
import { loadAll } from "../store/files/load.ts"
import { markSuperseded } from "../store/files/supersede.ts"
import { isVisibleTo, readerFromSid, type Reader } from "../store/model/visibility.ts";
import { runWriteGate, type GateContext } from "../gate/gate.ts";
import { captureEvidenceContext, record } from "../evidence/record.ts";
import { writeEvidence, hasGateCheck } from "../capture/triggers.ts";
import { writeTarget } from "../identity/repokey.ts";
import { getCurrent } from "../core/state.ts";
import { type GraphStatus, type ScriptRecord, detectScripts, ensureGraph, gitHead, gitRootOf } from "./detect.ts";

export interface InitArgs {
  liveRoot: string;
  force?: boolean;
  mode?: string;
  // The calling session (#127): rows this writes are stamped for the CALLER,
  // resolved after runInit's own awaits (git probing) rather than from the
  // ambient current, which a concurrent session may have moved.
  sessionID?: string;
}

export interface InitSummary {
  scope: string;
  root: string;
  head: string;
  graph: GraphStatus;
  scripts: ScriptRecord[];
  stampTs?: string;
  skipped: boolean;
  written: number;
  collapsed: number;
  blocked: number;
  /** Written rows whose write_promoted audit line fell (#155 review). */
  unaudited?: number;
}

export async function run(cmd: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    const [so, se] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { ok: code === 0, out: (so || se || "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

export interface InitStamp {
  ts: string;
  head: string;
}

export async function initStamp(scope: string, sid?: string, reader: Reader = readerFromSid(sid)): Promise<InitStamp | null> {
  // Scope is a basename, so two different repos can share one
  // ("api" next to "api", a fork beside its upstream). Visibility filtering
  // makes each repo see only its own stamp — basename collisions no longer
  // alias init state between repos. The reader comes from the CALLER's
  // session, not from the global current after this await (#127).
  const mems = (await loadAll()).filter((m) => !m.superseded_by && isVisibleTo(m, reader));
  for (const m of mems) {
    if (m.type !== "context" || m.scope !== scope) continue;
    if (!m.tags?.some((t) => t === "init-stamp")) continue;
    const head = /head=([^ ,]+)/.exec(m.content)?.[1] ?? "-";
    return { ts: m.ts, head };
  }
  return null;
}

export async function runInit(args: InitArgs): Promise<InitSummary> {
  const reader = readerFromSid(args.sessionID);
  const writeAt = writeTarget(args.sessionID ?? getCurrent().sid);
  const evidenceContext = captureEvidenceContext(args.sessionID);
  const root = await gitRootOf(args.liveRoot);
  const scope = basename(root) || basename(args.liveRoot);
  const head = await gitHead(root);
  const force = Boolean(args.force);
  const mode = args.mode ?? "moderate";

  const gateCtx: GateContext = {
    liveRoot: root,
    reader,
    writeAt,
    evidenceContext,
    ...writeEvidence(args.sessionID ?? getCurrent().sid),
    hasGateCheck: hasGateCheck(args.sessionID ?? getCurrent().sid),
    // Stamps land on the caller's session even though runInit awaits git
    // probing before the gate writes (#127 / #121's write-side root cause).
    sessionID: args.sessionID,
    trusted: true,
  };

  const prior = await initStamp(scope, args.sessionID, reader);
  if (prior && !force && prior.head === head) {
    await record("init_skip", { scope, head, since: prior.ts }, false, args.sessionID, evidenceContext);
    return {
      scope,
      root,
      head,
      graph: { action: "indexed", mode },
      scripts: [],
      stampTs: prior.ts,
      skipped: true,
      written: 0,
      collapsed: 0,
      blocked: 0,
    };
  }

  await record("init_start", { scope, head, force, mode }, false, args.sessionID, evidenceContext);

  const graph = await ensureGraph(root, mode, force);
  const scripts = await detectScripts(root);

  let written = 0;
  let collapsed = 0;
  let blocked = 0;
  // Promoted rows whose write_promoted audit line fell (#155 review: the
  // fault must be visible to every writer, bookkeeping included).
  let unaudited = 0;
  for (const s of scripts) {
    const content = `${scope} ${s.key} command: run "${s.cmd}" from the repo root (${s.source}).`;
    const outcome = await runWriteGate(
      { type: "pattern", scope, content, tags: ["init", s.source] },
      gateCtx,
    );
    if (outcome.action === "promoted") {
      written++;
      if (outcome.evidenceError !== undefined) unaudited++;
    } else if (outcome.action === "collapsed") collapsed++;
    else blocked++;
  }

  const stampContent = `Init stamp: repo=${scope}, head=${head}, graph=${graph.action}, mode=${graph.mode}, scripts=${scripts.length}`;
  const stampOutcome = await runWriteGate(
    { type: "context", scope, content: stampContent, tags: ["init-stamp"] },
    gateCtx,
  );
  const stampTs = stampOutcome.ts ?? prior?.ts;
  if (stampOutcome.action === "promoted" && prior && stampOutcome.ts) {
    await markSuperseded(prior.ts, { superseded_by: stampOutcome.ts, reason: "init" });
  }
  if (stampOutcome.action === "promoted" && stampOutcome.evidenceError !== undefined) unaudited++;

  await record(
    "init_complete",
    {
      scope,
      head,
      force,
      mode,
      graph: graph.action,
      scripts: scripts.length,
      written,
      collapsed,
      blocked,
      unaudited,
      stamp: stampTs ?? "-",
    },
    false,
    args.sessionID,
    evidenceContext,
  );

  return {
    scope,
    root,
    head,
    graph,
    scripts,
    stampTs,
    skipped: false,
    written,
    collapsed,
    blocked,
    unaudited,
  };
}
