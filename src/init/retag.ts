// One-time repair for rows stored before #372 screened init's writes (#375).
//
// #372 made `/repo-init` run the injection screen over the rows it writes, so a
// checkout sitting in a directory named `eval (x)` now gets its command memories
// tagged `quarantine`. That covers writes made after it shipped. A store that
// already holds an untagged poisoned row keeps it, and re-running init cannot
// fix it: GATE-3's exact-duplicate check compares type and content, so the new
// quarantined candidate collapses into the old untagged row. `force: true` does
// not help either — force skips the stamp check, not the dedup.
//
// So init scans what it can read and re-tags the hits. Each re-tag is a normal
// gated write that replaces the row it names (`supersedesTs`) — the one shape
// GATE-3 reads as a metadata edit rather than a duplicate. Nothing is deleted:
// the old row survives superseded, and every replacement emits its own
// `write_promoted` audit line.
import { runWriteGate, type GateContext } from "../gate/gate.ts";
import { markSuperseded } from "../store/files/supersede.ts";
import { loadAll } from "../store/files/load.ts";
import type { Memory } from "../store/model/memory.ts";
import { isActive } from "../store/model/predicates.ts";
import { isVisibleTo } from "../store/model/visibility.ts";
import {
  isQuarantined,
  quarantineCandidate,
} from "../store/quarantine/quarantine.ts";

/**
 * Writes one init run may make. A pathological store (an injection-shaped
 * directory name plus a thousand rows quoting it) must not turn one `/repo-init`
 * into a thousand full-file publishes. The remainder is reported, never hidden.
 */
export const MAX_RETAGS_PER_RUN = 100;

export interface RetagResult {
  /** Active rows the caller could read. */
  scanned: number;
  /** Rows replaced by a tagged twin AND retired. */
  retagged: number;
  /** Hits the gate refused; they stay active and untagged. */
  blocked: number;
  /** Promoted, but the retirement did not land (another supersession won). */
  partial: number;
  /** Promoted with a fallen `write_promoted` audit line (#155 class). */
  unaudited: number;
  /** Hits left unprocessed because the per-run bound was reached. */
  remaining: number;
  /** Rows GATE-2 retired as a side effect of these writes. Never hidden. */
  collateral: string[];
  /**
   * Retirement attempts that REJECTED (lock contention) rather than returning
   * false (#378 review). The replacement is durable; the original is not.
   * Counted in `partial`, named here.
   */
  failures: string[];
}

export function emptyRetag(): RetagResult {
  return {
    scanned: 0,
    retagged: 0,
    blocked: 0,
    partial: 0,
    unaudited: 0,
    remaining: 0,
    collateral: [],
    failures: [],
  };
}

/**
 * The row as it should be written again: identical prose and metadata, plus the
 * tags the screen asked for.
 *
 * Every field is copied on purpose. A repair that quietly dropped the verbatim
 * quote (`original`) or the contradiction fields would close one boundary and
 * break another, and `repo` is carried so a global row stays global while a
 * repository row stays in its own repository — an edit must never move a row's
 * visibility. The row's own `ts`, `file` and `superseded_by` are deliberately
 * NOT carried: the gate mints a fresh identity for the replacement.
 */
function reTagged(row: Memory, tags: string[]) {
  return {
    type: row.type,
    scope: row.scope,
    content: row.content,
    ...(row.issue ? { issue: row.issue } : {}),
    ...(row.kw ? { kw: row.kw } : {}),
    ...(row.ref ? { ref: row.ref } : {}),
    ...(row.claim ? { claim: row.claim } : {}),
    ...(row.klass ? { klass: row.klass } : {}),
    ...(row.original ? { original: row.original } : {}),
    status: row.status ?? "settled",
    repo: row.repo ?? "global",
    repoPath: row.repo ? row.repoPath : undefined,
    tags,
  };
}

/**
 * Re-tag rows that match the injection screen but do not carry the tag.
 *
 * Reach is exactly what the caller can read — this repository's rows plus global
 * rows. Another repository's rows are not this caller's to rewrite.
 */
export async function retagQuarantinedRows(
  ctx: GateContext,
): Promise<RetagResult> {
  const out = emptyRetag();
  const rows = (await loadAll()).filter(
    (m) =>
      isActive(m) &&
      !isQuarantined(m) &&
      (ctx.reader ? isVisibleTo(m, ctx.reader) : true),
  );
  out.scanned = rows.length;
  const hits: Memory[] = [];
  for (const row of rows) {
    // quarantineCandidate returns the same object when nothing matches.
    if (quarantineCandidate(row) !== row) hits.push(row);
  }
  if (hits.length > MAX_RETAGS_PER_RUN)
    out.remaining = hits.length - MAX_RETAGS_PER_RUN;
  for (const row of hits.slice(0, MAX_RETAGS_PER_RUN)) {
    const tagged = quarantineCandidate(row);
    const durable: string[] = [];
    const outcome = await runWriteGate(reTagged(row, tagged.tags ?? []), {
      ...ctx,
      supersedesTs: row.ts,
      durable,
    });
    if (outcome.action !== "promoted" && outcome.action !== "collapsed") {
      // Blocked: the untagged row stays exactly as it was, and the operator
      // has to hear that rather than read a clean repair.
      out.blocked++;
      continue;
    }
    // #378 review (WhollyMindless): two ways the unsafe original survived.
    // (a) COLLAPSED is not "nothing happened" here — it means a quarantined
    //     twin from an earlier interrupted repair is already durable, and the
    //     only missing step is retiring the original. Refusing to act on the
    //     collapse left the row unquarantined forever (retagged=0, blocked=1
    //     on every retry). The collapse survivor IS the twin: the re-tagged
    //     candidate differs from the original only by tags, and the
    //     supersedesTs carve-out keeps the original from matching as its own
    //     duplicate, so an exact-content match is the prior replacement.
    // (b) markSuperseded can REJECT (lock contention), not just return false.
    //     The twin is durable either way, so the failure lands in `partial`
    //     with its reason instead of escaping as if nothing was written —
    //     the #155 lesson, applied to the repair path.
    const successor =
      outcome.action === "collapsed" ? outcome.collapsedWith : outcome.ts;
    if (successor === undefined) {
      out.blocked++;
      continue;
    }
    let retired = false;
    try {
      retired = await markSuperseded(
        row.ts,
        {
          superseded_by: successor,
          reason: "init",
          symbol: row.ts,
          from: row.ts,
          to: successor,
        },
        durable,
      );
    } catch (err) {
      out.failures.push(
        `${row.ts}: ${err instanceof Error && err.message ? err.message : String(err)}`,
      );
    }
    for (const ts of durable)
      if (!out.collateral.includes(ts)) out.collateral.push(ts);
    if (!retired) {
      // The replacement IS durable. Name which half did not land, in the shape
      // memory_update uses (#155), instead of counting a clean re-tag.
      out.partial++;
      continue;
    }
    out.retagged++;
    if (outcome.evidenceError !== undefined) out.unaudited++;
  }
  return out;
}
