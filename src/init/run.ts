// run — split from src/init.ts (#168 domain restructure). Declaration bodies are unchanged.
// Repository init: re-derive build/test command memories through the write gate
// and record an init stamp keyed on git HEAD. Deterministic (no model calls):
// manifests are parsed locally and every write goes through the 4-gate pipeline
// with the `trusted` flag (plugin-authored bookkeeping, not model claims).
// Degrades gracefully when git is absent, so install-from-scratch still writes
// script memories. The codebase-memory graph integration was removed (#231).
// The stamp is a file under the memory root, not a memory row (#374): see
// src/init/stamp.ts for why a row was forgeable.
import { basename } from "node:path";
import { readerFromSid } from "../store/model/visibility.ts";
import { runWriteGate, type GateContext } from "../gate/gate.ts";
import { captureEvidenceContext, record } from "../evidence/record.ts";
import { writeEvidence, hasGateCheck } from "../capture/triggers.ts";
import { writeTarget } from "../identity/repokey.ts";
import { quarantineCandidate } from "../store/quarantine/quarantine.ts";
import { getCurrent } from "../core/state.ts";
import {
  type ScriptRecord,
  detectScripts,
  gitHead,
  gitRootOf,
} from "./detect.ts";
import { type RetagResult, retagQuarantinedRows } from "./retag.ts";
import { readStamp, writeStampFile } from "./stamp.ts";

export interface InitArgs {
  liveRoot: string;
  force?: boolean;
  // The calling session (#127): rows this writes are stamped for the CALLER,
  // resolved after runInit's own awaits (git probing) rather than from the
  // ambient current, which a concurrent session may have moved.
  sessionID?: string;
}

export interface InitSummary {
  scope: string;
  root: string;
  head: string;
  scripts: ScriptRecord[];
  stampTs?: string;
  skipped: boolean;
  written: number;
  collapsed: number;
  blocked: number;
  /** Written rows whose write_promoted audit line fell (#155 review). */
  unaudited?: number;
  /** The stamp file could not be written; init must be re-run (#374). */
  stampError?: string;
  /** True when a pre-#374 store row was honoured and copied to the file. */
  stampMigrated?: boolean;
  /**
   * A honoured pre-#374 row is still active: its retirement did not land
   * (#376 review). The migration itself is durable; the row is inert either
   * way, and the operator hears about it instead of reading a clean migration.
   */
  stampRetireError?: string;
  /** Pre-#372 rows re-tagged by the injection screen (#375). */
  retag?: RetagResult;
}

export async function runInit(args: InitArgs): Promise<InitSummary> {
  const reader = readerFromSid(args.sessionID);
  const writeAt = writeTarget(args.sessionID ?? getCurrent().sid);
  const evidenceContext = captureEvidenceContext(args.sessionID);
  const root = await gitRootOf(args.liveRoot);
  const scope = basename(root) || basename(args.liveRoot);
  const head = await gitHead(root);
  const force = Boolean(args.force);

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

  // #375: repair rows written before #372 screened init's output. This runs
  // BEFORE the stamp check on purpose — the common poisoned store belongs to a
  // repository init has already stamped, and returning early would leave the
  // poisoned row live forever. The scan is one store read and five regexes per
  // row; writes happen only on a hit.
  const retag = await retagQuarantinedRows(gateCtx);

  // The stamp is read from (and written to) a file named for the repository
  // identity key, never from a row a model could write (#374). The write target
  // already holds that identity, so the common path spends no git probes here.
  // Scope is still a basename, so two "api" checkouts stay apart: the key, not
  // the name, decides which stamp a repository reads.
  const stampKeyHint = writeAt.ok ? writeAt.scope?.key : undefined;
  const {
    stamp: prior,
    key: stampKey,
    migrated,
    stampError: migrateStampError,
    retireError,
  } = await readStamp(scope, root, stampKeyHint, args.sessionID, reader);
  if (prior && !force && prior.head === head) {
    await record(
      "init_skip",
      {
        scope,
        head,
        since: prior.ts,
        migrated: migrated || undefined,
        // #376 review: a migration that honoured the row but could not write the
        // file, or could not retire it, is a fault the skip line has to carry.
        // Without it every later init re-migrates and re-claims success with no
        // audit trail saying the file was never there.
        stamp_error: migrateStampError,
        stamp_retire_error: retireError,
        retagged: retag.retagged || undefined,
        retag_blocked: retag.blocked || undefined,
      },
      false,
      args.sessionID,
      evidenceContext,
    );
    return {
      scope,
      root,
      head,
      scripts: [],
      stampTs: prior.ts,
      skipped: true,
      written: 0,
      collapsed: 0,
      blocked: 0,
      stampError: migrateStampError,
      stampMigrated: migrated || undefined,
      stampRetireError: retireError,
      retag,
    };
  }

  await record(
    "init_start",
    { scope, head, force },
    false,
    args.sessionID,
    evidenceContext,
  );

  const scripts = await detectScripts(root);

  let written = 0;
  let collapsed = 0;
  let blocked = 0;
  // Promoted rows whose write_promoted audit line fell (#155 review: the
  // fault must be visible to every writer, bookkeeping included).
  let unaudited = 0;
  for (const s of scripts) {
    const content = `${scope} ${s.key} command: run "${s.cmd}" from the repo root (${s.source}).`;
    // Auto-capture and import both screen their candidate for injection-shaped
    // text; init's rows are external text too — the scope is the checkout
    // directory basename and the command comes from the manifest — so they get
    // the same scan (#302). A match is still stored, tagged `quarantine`, and
    // withheld from recall and injection.
    const outcome = await runWriteGate(
      quarantineCandidate({
        type: "pattern",
        scope,
        content,
        tags: ["init", s.source],
      }),
      gateCtx,
    );
    if (outcome.action === "promoted") {
      written++;
      if (outcome.evidenceError !== undefined) unaudited++;
    } else if (outcome.action === "collapsed") collapsed++;
    else blocked++;
  }

  // The stamp is bookkeeping about this run, not a claim for the model to read,
  // so it is a file rather than a gated row (#374). A fault is reported, never
  // swallowed: the honest consequence is "init will run again", and saying so
  // beats a stamp the operator believes was written.
  const stampTs = new Date().toISOString();
  const stampError = writeStampFile(stampKey, scope, root, head, stampTs);

  await record(
    "init_complete",
    {
      scope,
      head,
      force,
      scripts: scripts.length,
      written,
      collapsed,
      blocked,
      unaudited,
      stamp: stampError ? "-" : stampTs,
      stamp_error: stampError,
      // A migration that copied the row but could not retire it (#376 review).
      stamp_retire_error: retireError,
      migrated: migrated || undefined,
      retagged: retag.retagged || undefined,
      retag_blocked: retag.blocked || undefined,
      retag_partial: retag.partial || undefined,
      retag_failures: retag.failures.length
        ? retag.failures.join("; ")
        : undefined,
      retag_remaining: retag.remaining || undefined,
      retag_collateral: retag.collateral.length
        ? retag.collateral.join(",")
        : undefined,
    },
    false,
    args.sessionID,
    evidenceContext,
  );

  return {
    scope,
    root,
    head,
    scripts,
    stampTs: stampError ? (prior?.ts ?? undefined) : stampTs,
    stampError,
    stampMigrated: migrated || undefined,
    stampRetireError: retireError,
    skipped: false,
    written,
    collapsed,
    blocked,
    unaudited,
    retag,
  };
}
