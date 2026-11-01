// The memory_update tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { memoryRoot } from "../core/config/paths.ts";
import { record } from "../evidence/record.ts";
import { auditCaveat, runWriteGate, sameStrList } from "../gate/gate.ts";
import { withStoreLock } from "../store/lock.ts";
import { loadAll } from "../store/files/load.ts"
import { markSuperseded } from "../store/files/supersede.ts"
import { resolveMemoryTarget } from "../store/files/target.ts"
import { isActive } from "../store/model/predicates.ts"
import { isVisibleTo, readerFromSid } from "../store/model/visibility.ts";
import type { Memory } from "../store/model/memory.ts";
import { UpdateArgs, validated } from "./schema.ts";
import { redactSecrets } from "../store/secrets.ts";
import { join } from "node:path";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, bindSessionIdentity, ownerlessWriter, refuseOwnerlessWrite, gateContext, direct } = deps;
    editor.add(validated(UpdateArgs, {
      name: "memory_update",
      description:
        "Update an existing memory (gated like remember; the prior entry is superseded, not erased). `query` selects which row to update: its exact id (ts), a clock fragment (e.g. HH:MM:SS.mmm), or a unique substring of its content. Omitting `query` targets the most recent active row of scope+type. An unmatched or ambiguous `query` fails closed and writes nothing. A prose edit carries over everything the call does not name — tags, issue, keywords, status, and the row's repository. Naming a row that was already updated to exactly this content (metadata included) reports the duplicate; if its live successor holds the prose and only the metadata you name differs, the successor is updated. A failure after the write is reported as PARTIAL: the replacement is durable and memory_undo merge/force restores the old row.",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        await bindSessionIdentity(sid);
        const ownerless = ownerlessWriter(sid);
        if (ownerless) return await refuseOwnerlessWrite(ownerless, "update");
        const reader = readerFromSid(sid);
        const updateGate = gateContext(sid);
        // The whole update — resolve, gate, supersede — runs under one
        // UPDATE-ORDER lock. Without it, two concurrent updates that both
        // resolved the same still-active target both promoted and both
        // claimed success: markSuperseded is first-call-wins, so one
        // replacement row silently survived un-superseded (measured 5/5).
        // This outer lock is a DISTINCT file from anything runWriteGate or
        // markSuperseded take (sections run flat — never re-enter a file
        // you hold), and the acquisition order is always update-order
        // then store, never the reverse, so it cannot deadlock against a
        // plain writer. On timeout it FAILS closed: proceeding unlocked
        // is exactly the race this lock exists to close. The loser then
        // re-resolves under the lock, finds its target already retired,
        // and writes nothing — the documented fail-closed contract.
        // Flips once a replacement row is durable, so the catch below can
        // never claim "Nothing was written" about a write that happened
        // (#155's lie).
        let mutated = false;
        // The gate's durable steps: rows GATE-2 retired before a later
        // failure (round-3 probe 3). Non-empty means "Nothing was written"
        // is no longer writable.
        const gateDurable: string[] = [];
        try {
          return await withStoreLock(
            join(memoryRoot(), "update-order"),
            async () => {
              const prior = (await loadAll()).filter(
                (m) => m.scope === args.scope && m.type === args.type && isActive(m) && isVisibleTo(m, reader),
              );
              // Resolve the row BEFORE the gate: an update that cannot identify its
              // target must write nothing, rather than silently superseding whichever
              // row happened to be newest in this scope+type.
              let resolved = resolveMemoryTarget(prior, args.query);
              if (resolved.status === "not_found") {
                // Naming a SUPERSEDED row is not a miss (#155): the retry
                // after a partial update lands here, and when that row's
                // active successor already carries exactly this content the
                // honest verdict is the duplicate one, not a dead end. Two
                // subtleties the first cut missed: the successor's prose was
                // stored REDACTED while a retry re-carries the raw input
                // (the comparison must scrub), and "exactly this content"
                // must mean the metadata too — a retry that also names new
                // keywords still has work to do, and that work belongs on
                // the chain head, so the update CONTINUES against the
                // successor instead of collapsing here.
                let chainHead: Memory | undefined;
                if (args.query) {
                  const rows = (await loadAll()).filter(
                    (m) => m.scope === args.scope && m.type === args.type && isVisibleTo(m, reader),
                  );
                  const stale = resolveMemoryTarget(rows, args.query);
                  if (stale.status === "ok" && stale.target && !isActive(stale.target)) {
                    let latest = stale.target;
                    const walked = new Set<string>([latest.ts]);
                    while (latest.superseded_by) {
                      const next = rows.find((m) => m.ts === latest.superseded_by);
                      if (!next || walked.has(next.ts)) break;
                      walked.add(next.ts);
                      latest = next;
                    }
                    if (isActive(latest) && latest.content.trim() === redactSecrets(args.content).trim()) {
                      const restated =
                        (args.kw === undefined || sameStrList(args.kw, latest.kw)) &&
                        (args.status === undefined || args.status === (latest.status ?? "settled"));
                      if (restated) {
                        // Every other verdict is auditable; this one must
                        // be too — the message tells the model to consult
                        // memory_evidence.
                        await record(
                          "dedup_collapse",
                          { op: "update", named: stale.target.ts, match: latest.ts, action: "exact_successor", incoming_ignored: true },
                          true,
                          sid,
                        );
                        return {
                          content:
                            `Duplicate ignored: ${args.type}/${args.scope} — ${JSON.stringify(args.query)} was already ` +
                            `updated to exactly this content (${latest.ts}). Nothing was written.`,
                        };
                      }
                      chainHead = latest;
                    }
                  }
                }
                if (!chainHead) {
                  const where = args.query ? ` matches ${JSON.stringify(args.query)}` : "";
                  return {
                    content: `memory_update blocked: no active ${args.type} row in ${args.scope}${where}. Nothing was written.`,
                  };
                }
                resolved = { status: "ok", target: chainHead };
              }
              if (resolved.status === "ambiguous") {
                return {
                  content:
                    `memory_update blocked: ${JSON.stringify(args.query)} matches ${resolved.candidates.length} active ` +
                    `${args.type} rows in ${args.scope} (${resolved.candidates.map((m) => m.ts).join(", ")}). ` +
                    "Pass a row id or a unique content substring. Nothing was written.",
                };
              }
              const target = resolved.target;
              // A prose edit is not a metadata reset (#154): fields the
              // call does not name carry over from the row being
              // replaced, so updating an imported row can no longer
              // launder away its provenance or issue link. kw follows
              // the same rule with an override: omitted keeps the
              // target's, provided replaces. The carry completes to the
              // five fields of the #129 viewer precedent: STATUS (an
              // open frontier row stays open) and REPO (updating a
              // global row from one repository must not re-house it out
              // of every other repository's view — "an edit must never
              // widen visibility", and it must never narrow it either).
              // These are also the fields the collapse-completion judges
              // (review round 3): the fold asks whether the survivor
              // already carries the REQUESTED state — not the pre-edit
              // target's. An update naming kw:["new-alias"] is not
              // "already standing" on a row holding ["old-alias"].
              const requested = {
                kw: args.kw ?? target.kw,
                tags: target.tags,
                issue: target.issue,
                status: (args.status ?? target.status) ?? "settled",
                repo: target.repo ?? "global",
              };
              const outcome = await runWriteGate(
                {
                  type: args.type,
                  scope: args.scope,
                  content: args.content,
                  kw: requested.kw,
                  tags: requested.tags,
                  issue: requested.issue,
                  status: requested.status,
                  repo: requested.repo,
                  repoPath: target.repo ? target.repoPath : undefined,
                },
                { ...updateGate, reader, supersedesTs: target.ts, durable: gateDurable },
              );
              if (outcome.action === "promoted" && outcome.ts && target) {
                mutated = true;
                const replacement = outcome.ts;
                const retired = target.ts;
                // The merge_review PARTIAL shape (156e887) applied to
                // update: the replacement IS durable, so the message says
                // exactly which follow-up step failed and what a retry does
                // (#155 — never claim "Nothing was written" from here).
                const partial = (why: string) => ({
                  content:
                    `memory_update PARTIAL: replacement ${replacement} IS on disk (memory_undo merge or force ` +
                    `restores ${retired}), but ${why}. Re-running this update reports the duplicate.`,
                });
                let retiredNow = false;
                try {
                  retiredNow = await markSuperseded(retired, {
                    superseded_by: replacement,
                    reason: "update",
                    symbol: retired,
                    from: retired,
                    to: replacement,
                  });
                } catch (err) {
                  return partial(
                    `retiring ${retired} failed: ${err instanceof Error && err.message ? err.message : String(err)}`,
                  );
                }
                if (!retiredNow) {
                  // merge_review checks exactly this boolean (156e887);
                  // "Updated (superseded X)" cannot be printed over a
                  // retirement a parallel supersession performed — that
                  // pointer names a DIFFERENT successor, and the confident
                  // line would hide a second active row.
                  return partial(
                    `${retired} had ALREADY been retired by another supersession while this call ran — ` +
                      `it points at that successor, not at ${replacement}; check memory_evidence`,
                  );
                }
                if (outcome.evidenceError !== undefined) {
                  return partial(`its write_promoted audit line was not recorded (${outcome.evidenceError})`);
                }
                return { content: `Updated ${args.type} in ${args.scope} (superseded ${retired})` };
              }
              if (outcome.action === "promoted")
                return { content: `Remembered: ${args.type} in ${args.scope}${auditCaveat(outcome)}` };
              if (outcome.action === "collapsed") {
                // Completion (#155 convergence): when a retry collapses
                // because an ACTIVE row already holds exactly this content
                // while the row it NAMES is still active (the supersede
                // step of an earlier PARTIAL attempt never landed), the
                // idempotent close is to retire the named row in the
                // survivor's favor — a bare "Duplicate ignored" would leave
                // two active rows forever and a retry that never converges.
                // first-call-wins makes this safe to attempt on any path.
                // But the fold must not INVERT #154 (review): retiring the
                // named row is loss-free only when the survivor already
                // carries what the named row carries — the SAME predicate
                // GATE-3 uses to call same-prose-different-metadata an
                // edit rather than a duplicate. Otherwise the survivor
                // would stand stripped of the named row's issue link,
                // keywords, tags or OPEN frontier standing, and a "clean
                // no-op" message would paper over a metadata destruction.
                // On disagreement nothing retires: both ids are named and
                // a human (or an update on the survivor) decides.
                const survivorTs = outcome.collapsedWith;
                if (target && survivorTs && survivorTs !== target.ts) {
                  // #175: the gate can observe a session move after this call captured
                  // its reader. Recheck before trusting or describing the survivor.
                  const survivor = (await loadAll()).find(
                    (m) => m.ts === survivorTs && !m.superseded_by && isVisibleTo(m, reader),
                  );
                  if (survivor) {
                    // #175: private rows are visible by key OR path. Equal keys alone
                    // can drop another checkout's access after an origin change.
                    // For global rows, isVisibleTo ignores paths.
                    // Match raw paths like isVisibleTo; filesystem aliases need not
                    // grant the same readers access. This restricts automatic folds;
                    // explicit merge_review authorizes both seats under #131 instead.
                    const samePathVisibility = requested.repo === "global" ||
                      (target.repoPath ?? "") === (survivor.repoPath ?? "");
                    // The predicate is the REQUESTED state vs the survivor
                    // (round 3): content equality is already proven by the
                    // collapse, so the fold is loss-free only when the
                    // survivor also carries the metadata THIS call asked
                    // for — and stands where the target stands for readers
                    // of other repositories (repo visibility: folding a
                    // global row into a repo-private survivor would
                    // narrow a visibility the promotion path exists to
                    // preserve, and the reverse would leak).
                    if (
                      sameStrList(requested.kw, survivor.kw) &&
                      sameStrList(requested.tags, survivor.tags) &&
                      requested.issue === survivor.issue &&
                      requested.status === (survivor.status ?? "settled") &&
                      requested.repo === (survivor.repo ?? "global") &&
                      samePathVisibility
                    ) {
                      const done = await markSuperseded(target.ts, {
                        superseded_by: survivorTs,
                        reason: "update",
                        symbol: target.ts,
                        from: target.ts,
                        to: survivorTs,
                      }, gateDurable);
                      if (done) {
                        return {
                          content:
                            `Duplicate: ${args.type}/${args.scope} already stands active as ${survivorTs}; ` +
                            `${target.ts} was retired in its favor. Nothing new was written.`,
                        };
                      }
                    } else {
                      const differs: string[] = [];
                      if (requested.status !== (survivor.status ?? "settled"))
                        differs.push(`status ${requested.status} vs ${survivor.status ?? "settled"}`);
                      if (requested.issue !== survivor.issue)
                        differs.push(`issue ${requested.issue ?? "-"} vs ${survivor.issue ?? "-"}`);
                      if (!sameStrList(requested.kw, survivor.kw))
                        differs.push(`kw [${(requested.kw ?? []).join(", ") || "-"}] vs [${(survivor.kw ?? []).join(", ") || "-"}]`);
                      if (!sameStrList(requested.tags, survivor.tags))
                        differs.push(`tags [${(requested.tags ?? []).join(", ") || "-"}] vs [${(survivor.tags ?? []).join(", ") || "-"}]`);
                      if (requested.repo !== (survivor.repo ?? "global"))
                        differs.push(`visibility ${requested.repo} vs ${survivor.repo ?? "global"}`);
                      if (!samePathVisibility) differs.push("repository path visibility differs");
                      return {
                        content:
                          `Duplicate: ${args.type}/${args.scope} stands active as ${survivorTs}, but ${target.ts} ` +
                          `was NOT retired — the survivor does not carry what this update asked for ` +
                          `(${differs.join("; ")}), and the fold would drop it. Both stay active. To deliberately ` +
                          `keep only the survivor, use memory_merge_review with loser="${target.ts}", ` +
                          `survivor="${survivorTs}", and an explicit reason. This keeps the survivor's metadata and visibility.`,
                      };
                    }
                  }
                }
                return { content: `Duplicate ignored: ${args.type}/${args.scope}` };
              }
              return { content: `Write blocked at GATE (${outcome.reason}). ${outcome.hint ?? ""}`.trimEnd() };
            },
            {
              onTimeout: "fail",
              onEvent: (event, waitedMs) => {
                void record("store_lock", { event, waited_ms: waitedMs, op: "update" });
              },
            },
          );
        } catch (err) {
          // Everything that still throws here was PRE-WRITE for THIS call's
          // replacement: the fail-closed lock timeout, the #152 choke-point
          // refusal, an evidence fault BEFORE the append. Post-append audit
          // failures no longer reach this catch — the gate reports them on
          // the promoted outcome (#155). mutated is the belt-and-braces
          // truth check: a future post-write throw must report a partial,
          // never a clean nothing. And gateDurable closes the last gap
          // (round 3): the gate may have RETIRED OTHER rows at GATE-2
          // before the fault that got here — those tombstones are on disk,
          // and naming them beats the "Nothing was written" premise.
          const msg = err instanceof Error && err.message ? err.message : String(err);
          return {
            content: mutated
              ? `memory_update PARTIAL: a step after the durable write failed: ${msg}. ` +
                "Re-running this update reports the duplicate; inspect with memory_evidence."
              : gateDurable.length > 0
                ? `memory_update PARTIAL: ${msg} No replacement was written, but this call had ALREADY retired ` +
                  `${gateDurable.length} row(s) (${gateDurable.join(", ")}): those retirements ARE on ` +
                  "disk and their audit lines may not all have landed. Re-running this update will not undo " +
                  "them — reconcile with memory_evidence / memory_undo before retrying."
                : `memory_update blocked: ${msg} Nothing was written.`,
          };
        }
      },
    }));
};
