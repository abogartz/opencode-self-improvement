// Value-keyed rejection tombstones (#35).
//
// The promise under test: when a human rejects a value, that value stays
// rejected — even after the row carrying it is deleted, and even when the
// thing that comes back is the same statement reworded rather than the same
// bytes. The blocklist cannot provide this (it keys on `ts`, and a re-ingested
// fact arrives with a new one) and neither can prune (it deletes the rejection
// along with the row).
//
// The two failure directions are not symmetric, and the suite treats them that
// way:
//   - UNDER-blocking is the bug the ticket is about: a rejected fact returns.
//   - OVER-blocking is the bug that would make the mechanism unusable: a
//     legitimate new write silently refused because it resembles something a
//     human once deleted. Short content is one dangerous shape (small token
//     sets score high against almost anything); a CORRECTION of a rejected fact
//     is the other, and it is worse, because the only way out of the refusal is
//     lifting the rejection of the wrong statement it replaced. Both are pinned
//     explicitly — the second one in "a near-match releases a changed value".
//
// Also pinned here: the tombstone file stores hashes and metadata only (atlas
// step-10 inversion — a deletion log that reproduces what it deleted is a
// compliance problem), it is never ingested as a memory row, and lifting a
// rejection is reachable by a HUMAN and by no plugin tool, so a session whose
// write was refused cannot clear its own refusal.
//
// Hermetic like the rest of the suite: temp OPENCODE_MEMORY_DIR, no repo touch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryRoot } from "../src/config.ts";
import { contentHash } from "../src/evidence.ts";
import { runWriteGate } from "../src/gates.ts";
import { formatLine } from "../src/logfmt.ts";
import { loadAll, prune } from "../src/memory.ts";
import { resetSessionScopes, setRepoScope } from "../src/repokey.ts";
import { redactSecrets, REDACTED_SECRET } from "../src/secrets.ts";
import { resetState } from "../src/state.ts";
import { numericTokens, polaritySigns } from "../src/tokenize.ts";
import {
  findRejection,
  NEAR_FLOOR,
  rejectedFile,
  removeTombstone,
  resetTombstoneCache,
  sketchOf,
  tombstone,
  tombstones,
} from "../src/tombstones.ts";
import { blockMemory, unblockMemory } from "../src/viewer/mutate.ts";
import { blockedEntries } from "../src/blocklist.ts";
import { loadPlugin } from "./harness.ts";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-tomb-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
});

afterEach(() => {
  setRepoScope(null);
  resetSessionScopes();
  resetState();
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

let root: string;

/** A grounded gate context: refs/engagement satisfied, so the ONLY thing that
 *  can refuse these writes is the rejection check. */
const ctx = () => ({ liveRoot: root, evidenceCalls: [], hasGateCheck: true, hasEngagement: true });

const REJECTED =
  "decided to adopt the express framework for the http layer and terminate tls at the load balancer";
// The same statement, reworded: different bytes (so `ch` differs), same claim
// (so the token set is nearly the same).
const REWORDED =
  "the http layer adopts express, with tls terminated at the load balancer";
// A different fact in the same scope, sharing only domain vocabulary.
const UNRELATED =
  "the image pipeline resizes uploads to 2048 pixels before writing them to object storage";

async function promote(content: string, scope = "http", type = "decision") {
  return runWriteGate({ type, scope, content }, ctx());
}

describe("rejection survives deletion of the row that held it", () => {
  test("exact content replayed after a forget is refused, not stored", async () => {
    expect((await promote(REJECTED)).action).toBe("promoted");

    const res = await prune("http", "decision", "wrong call, do not record this");
    expect(res.deleted).toHaveLength(1);

    const replay = await promote(REJECTED);
    expect(replay.action).toBe("blocked");
    expect(replay.reason).toBe("previously_rejected");
    expect(await loadAll()).toHaveLength(0);
  });

  test("the refusal names when, why, and the hash the human needs to lift it", async () => {
    await tombstone(REJECTED, { reason: "wrong call", source: "forget", scope: "http", type: "decision" });

    const replay = await promote(REJECTED);
    const hint = replay.hint ?? "";
    expect(hint).toContain("wrong call");
    expect(hint).toContain(new Date().toISOString().slice(0, 10));
    expect(hint).toMatch(/[0-9a-f]{12}/);
    expect(hint).toContain("no tool that lifts a rejection");
  });

  // The escape hatch has to be present on BOTH verdicts. An earlier shape put
  // it only on the near-match hint, which left the common case — a byte-exact
  // replay — reported as a dead end.
  test("both the exact and the near refusal carry the way out", async () => {
    await tombstone(REJECTED, { reason: "wrong call", source: "forget" });
    const exact = (await promote(REJECTED)).hint ?? "";
    const near = (await promote(REWORDED)).hint ?? "";
    for (const hint of [exact, near]) {
      expect(hint).toContain("un-reject");
      expect(hint).toContain("no tool that lifts a rejection");
    }
    // And they are distinguishable: one says exact, the other quotes a score.
    expect(exact).toContain("This exact content");
    expect(near).toContain("similar to a value rejected");
  });

  test("the refusal is audited: dedup_rejected then write_blocked, value never logged", async () => {
    await tombstone(REJECTED, { reason: "poisoned", source: "forget" });
    const ev: string[] = [];
    const outcome = await runWriteGate(
      { type: "decision", scope: "http", content: REJECTED },
      { ...ctx(), evidenceCalls: ev },
    );
    expect(outcome.action).toBe("blocked");

    const log = readFileSync(join(memoryRoot(), "evidence", `${new Date().toISOString().slice(0, 10)}.logfmt`), "utf8");
    expect(log).toContain("ev=dedup_rejected");
    expect(log).toContain("match_kind=exact");
    expect(log).toContain("reason=previously_rejected");
    // The prose must not appear in EITHER the evidence log or the tombstone.
    expect(log).not.toContain("terminate tls at the load balancer");
  });
});

describe("near-match closes the rewording hole", () => {
  test("a reworded rejected value is refused", async () => {
    expect((await promote(REJECTED)).action).toBe("promoted");
    await prune("http", "decision", "wrong call");

    const reworded = await promote(REWORDED);
    expect(reworded.action).toBe("blocked");
    expect(reworded.reason).toBe("previously_rejected");
    expect(reworded.hint ?? "").toContain("similar");
    expect(await loadAll()).toHaveLength(0);
  });

  test("the sketch scores a rewording far above an unrelated fact", () => {
    const rejected = sketchOf(REJECTED);
    const reworded = sketchOf(REWORDED);
    const unrelated = sketchOf(UNRELATED);
    expect(jac(rejected, reworded)).toBeGreaterThanOrEqual(0.5);
    expect(jac(rejected, unrelated)).toBeLessThan(0.2);
  });

  test("an unrelated fact in the same scope still stores clean", async () => {
    await tombstone(REJECTED, { reason: "wrong call", source: "forget", scope: "http", type: "decision" });
    expect((await promote(UNRELATED)).action).toBe("promoted");
  });

  // The UPPER side of the floor. "An unrelated fact stores clean" is not enough
  // to pin it: genuinely unrelated prose scores 0.0, so it stays green even with
  // a near-floor of 0.05 and an over-aggressive mechanism looks fine. These are
  // the pairs that actually score against a floor — same vocabulary, same topic,
  // a DIFFERENT claim (measured 0.059-0.235). A human deleting one must not be
  // allowed to veto the others.
  test("a different claim in the same topic is NOT refused", async () => {
    const sameTopicDifferentClaim = [
      [
        "decided to adopt the express framework for the http layer and terminate tls at the load balancer",
        "decided to move the http layer to fastify because express lacks schema validation",
      ],
      [
        "we run migrations with bun migrate before every deploy",
        "migrations were rolled back manually once bun migrate timed out",
      ],
      [
        "the release workflow publishes to npm before it creates the github release",
        "the release workflow failed because the npm token expired mid run",
      ],
    ] as const;
    const refused: string[] = [];
    for (const [wasRejected, newClaim] of sameTopicDifferentClaim) {
      expect((await promote(wasRejected)).action).toBe("promoted");
      await prune("http", "decision", "wrong call");
      const next = await promote(newClaim);
      if (next.action === "blocked") refused.push(`${newClaim} <- ${next.hint ?? "?"}`);
    }
    // Empty means no legitimate rewrite was vetoed; a failure prints exactly
    // which claim was refused and by what reasoning.
    expect(refused).toEqual([]);
  });

  test("near-match never fires on short content, which is where false positives live", async () => {
    await tombstone("use bun for scripts", { reason: "stale", source: "forget" });
    // Byte-identical: still refused, because that is an exact match, not a guess.
    expect((await promote("use bun for scripts", "tooling")).action).toBe("blocked");
    // Different short content: must NOT be refused. Two dozen-token strings can
    // share most of their tokens by accident; a refusal here would be a lie.
    expect((await promote("prefer pnpm workspaces for monorepos", "tooling")).action).toBe("promoted");
  });

  test("findRejection reports the strongest near-match, not the first", async () => {
    await tombstone(REJECTED, { reason: "first", source: "forget" });
    await tombstone(
      "the http layer adopts express and terminates tls at the load balancer today",
      { reason: "second", source: "forget" },
    );
    const hit = await findRejection(REWORDED);
    expect(hit?.kind).toBe("near");
    if (hit?.kind === "near") expect(hit.score).toBeGreaterThan(0);
  });
});

describe("the tombstone holds hashes, never values", () => {
  test("rejected prose appears nowhere in rejected.logfmt", async () => {
    // A real forget, so the contrast below is produced by the same flow rather
    // than by hand-written fixtures.
    expect((await promote(REJECTED)).action).toBe("promoted");
    await prune("http", "decision", "wrong call, do not record this");

    const raw = readFileSync(rejectedFile(), "utf8");
    expect(raw).not.toContain("express");
    expect(raw).not.toContain("balancer");
    expect(raw).toContain("ch=");
    expect(raw).toContain("sig=");
    // The contrast that stops this pin passing vacuously: the DELETION audit
    // does keep the prose verbatim (that is its documented job), which is
    // precisely why the tombstone must not add a second copyable body.
    const deletions = readFileSync(join(memoryRoot(), "deletions.logfmt"), "utf8");
    expect(deletions).toContain("balancer");
  });

  // The value signatures added after the first review must not turn the file back
  // into a copy of what a human deleted: `num` holds HASHES of the numbers and
  // `pol` a two-value sign, so the retention period that was forgotten stays
  // forgotten. (Asserted field-by-field rather than over the raw line because ch,
  // sig and the timestamp are all hex/digits, so a substring check on "30" would
  // be an accident in either direction.)
  test("value signatures stay hashes and labels, never the value", async () => {
    const withValue = "the production service retains audit records for 45 days before cleanup";
    await tombstone(withValue, { reason: "wrong policy", source: "forget" });

    const raw = readFileSync(rejectedFile(), "utf8");
    expect(raw).not.toContain("retains");
    expect(raw).toContain("num=");
    expect(raw).toContain("pol=");

    const row = (await tombstones())[0];
    expect(row.num).toHaveLength(1);
    expect(row.num?.[0]).toMatch(/^[0-9a-f]{8,}$/);
    // Nothing in that sentence asserts an activation or prohibition, so the
    // polarity set is empty but PRESENT — the difference between "no value" and
    // "no signature at all" (a pre-tracking row) is what the guard keys on.
    expect(row.pol).toEqual([]);
  });

  test("rejected.logfmt is never ingested as a memory row", async () => {
    await tombstone(REJECTED, { reason: "wrong call", source: "forget" });
    expect(await loadAll()).toHaveLength(0);
  });

  test("an idempotent rejection does not append a second line for the same value", async () => {
    await tombstone(REJECTED, { reason: "first", source: "forget" });
    const second = await tombstone(REJECTED, { reason: "again", source: "forget" });
    expect(second.recorded).toBe(false);
    expect(await tombstones()).toHaveLength(1);
  });

  // A bulk forget is the common shape (prune deletes by scope+type, not by row),
  // and tombstones are written as ONE batched append. Every value in the batch
  // has to survive as its own parseable line: an earlier version joined the
  // batch with "" — formatLine returns no terminator — so 40 records landed as
  // one line and only the first parsed. Nothing else in this suite wrote more
  // than one value per call, so nothing caught it.
  test("a bulk forget records EVERY value, not just the first", async () => {
    // type "learning" on purpose: 40 near-identical rows are exactly what a bulk
    // scope forget produces, and decisions compete at a 0.3 overlap floor, which
    // would block them here for a reason unrelated to what this pins.
    const lines = Array.from(
      { length: 40 },
      (_, i) => `release gate ${i} requires a distinct green pipeline run`,
    );
    for (const content of lines) {
      expect((await promote(content, "http", "learning")).action).toBe("promoted");
    }
    const res = await prune("http", "learning", "bulk");
    expect(res.deleted).toHaveLength(40);

    const all = await tombstones();
    expect(all).toHaveLength(40);
    // Every one of them must be individually matched by the gate, which is the
    // whole point: a rejection that failed to parse rejects nothing.
    const refused: number[] = [];
    for (const [i, content] of lines.entries()) {
      const again = await promote(content, "http", "learning");
      if (again.action === "blocked") refused.push(i);
    }
    expect(refused).toHaveLength(40);
    // And the raw file really is 40 lines, so the count above cannot be a
    // parser coincidence.
    expect(readFileSync(rejectedFile(), "utf8").trimEnd().split("\n")).toHaveLength(40);
  });
});

// ---- What a near-match must NOT refuse -------------------------------------
//
// A near-match refusal is AUTHORITATIVE: it tells the model "this is the value a
// human rejected", and the only way out is lifting the rejection of the OLD
// statement. So it has to be right about the two things that make a statement a
// different fact. Both shapes below were measured on the shipped floor and both
// were refused:
//
//   "retains audit records for 30 days" -> "…for 90 days"      sketch 0.800
//   "must enable anonymous access"      -> "…must disable …"   sketch 0.778
//
// They score ABOVE the intended rewordings (0.500-0.615), which is why no scalar
// floor can fix this: raising it past 0.8 to release the corrections also releases
// nothing between them, and the corrections are the more common shape. What
// distinguishes them is not the score but the fact that a load-bearing VALUE
// moved, so the tombstone records one per value dimension (numeric hashes and
// 3-letter polarity signs — never prose) and vetoes the near-match when EACH side
// asserts something the other does not on a dimension. Extension is not
// disagreement and neither is omission — both were regressions, and both are
// pinned in the restatement list below.
describe("a near-match releases a changed value, not only a rewording", () => {
  const DAYS_WAS = "the production service retains audit records for 30 days before cleanup";
  const DAYS_IS = "the production service retains audit records for 90 days before cleanup";
  const MODE_WAS = "the service must enable anonymous access for production control endpoints";
  const MODE_IS = "the service must disable anonymous access for production control endpoints";

  test("a corrected number stores clean although the sketch clears the floor", async () => {
    // The premise, pinned so a future tweak that changes the scoring cannot make
    // this pass vacuously: without the value guard this pair IS a near-match.
    expect(jac(sketchOf(DAYS_WAS), sketchOf(DAYS_IS))).toBeGreaterThanOrEqual(NEAR_FLOOR);

    expect((await promote(DAYS_WAS)).action).toBe("promoted");
    await prune("http", "decision", "wrong policy");

    const next = await promote(DAYS_IS);
    expect(next.action).toBe("promoted");
    expect((await loadAll()).map((m) => m.content)).toContain(DAYS_IS);
  });

  test("an opposite instruction stores clean although the sketch clears the floor", async () => {
    expect(jac(sketchOf(MODE_WAS), sketchOf(MODE_IS))).toBeGreaterThanOrEqual(NEAR_FLOOR);

    expect((await promote(MODE_WAS)).action).toBe("promoted");
    await prune("http", "decision", "wrong policy");

    const next = await promote(MODE_IS);
    expect(next.action).toBe("promoted");
    expect((await loadAll()).map((m) => m.content)).toContain(MODE_IS);
  });

  // The other direction, and the one that keeps the guard honest: releasing
  // corrections must not dissolve the rewording guarantee, which is the whole
  // point of the near-match. Every pair below restates the rejected claim with
  // its values INTACT (same number, or a synonym / negation of the same polarity
  // verb) and must still be refused.
  test("the guard does not dissolve the rewording guarantee", async () => {
    const restatements = [
      // same retention period, reworded prose
      [DAYS_WAS, "audit records are kept by the production service for 30 days and then purged"],
      // a synonym of the rejected polarity verb
      [MODE_WAS, "the service shall allow anonymous access for production control endpoints"],
      // the rejected polarity reached by negating its opposite. This pair also
      // pins match SELECTION: it scores HIGHER against MODE_WAS (0.889, a flipped
      // polarity, so correctly not the rejected fact) than against MODE_IS (0.700,
      // the real one), so the guard must fall through to the weaker match rather
      // than report the strongest — and name the rejection it actually restates.
      [MODE_IS, "the service must not enable anonymous access for production control endpoints"],
      // reworded with the value DROPPED: the value is gone, but nothing asserts it
      // CHANGED — see differsIn, or deleting "30" would be a way to smuggle a
      // rejected claim back in.
      [DAYS_WAS, "the production service retains audit records before cleanup"],
      // EXTRA numeric metadata around an intact assertion. The rejected claim
      // still says 30 days, so "{30} vs {30,2}" is not a corrected value — this is
      // the shape a note, a revision number or a count appended to the sentence
      // makes, and it was being released.
      [DAYS_WAS, `${DAYS_WAS} (policy revision 2)`],
      // A negation of the opposite verb expressed with a word that is ITSELF a
      // polarity term. "Never disable" asserts the same thing as "enable", so it
      // restates the rejected claim; it was being released because `never`
      // contributed its own sign as well as flipping "disable".
      [MODE_WAS, "the service must never disable anonymous access for production control endpoints"],
    ] as const;

    const leaked: string[] = [];
    for (const [wasRejected, reworded] of restatements) {
      const { ch } = await tombstone(wasRejected, { reason: "wrong call", source: "forget" });
      const again = await promote(reworded);
      if (again.action !== "blocked" || again.reason !== "previously_rejected") {
        leaked.push(`${reworded} <- action=${again.action} reason=${again.reason ?? "-"}`);
      } else if (!(again.hint ?? "").includes(ch)) {
        // Refusing is not enough — the hint has to name the rejection it actually
        // restates, not the highest-scoring one. Three tombstones are in the file
        // by the last iteration, and the third pair is refused by the weaker of
        // two matches, so this is what catches a "strongest wins" regression.
        leaked.push(`${reworded} <- refused, but pointing at the wrong rejection`);
      }
    }
    expect(leaked).toEqual([]);
  });

  // Observability, because a guard that silently declines to refuse is
  // unfalsifiable in the field: the veto and which dimension said "different
  // fact" land on the evidence line.
  test("a declined near-match is audited with the reason it declined", async () => {
    await tombstone(DAYS_WAS, { reason: "wrong policy", source: "forget" });
    const ev: string[] = [];
    const out = await runWriteGate(
      { type: "decision", scope: "http", content: DAYS_IS },
      { ...ctx(), evidenceCalls: ev },
    );
    expect(out.action).toBe("promoted");

    const log = readFileSync(
      join(memoryRoot(), "evidence", `${new Date().toISOString().slice(0, 10)}.logfmt`),
      "utf8",
    );
    expect(log).toContain("ev=rejection_vetoed");
    expect(log).toContain("differs=numeric_value");
    expect(log).toContain("match_ch=");
    // Same rule as every other rejection line: hashes, never the rejected prose.
    expect(log).not.toContain("audit records");
  });

  // The veto is NOT "no numbers in common". Both statements assert 5 copies, and
  // that shared metadata is not the point: each side also asserts a number the
  // other does not, which is what makes 30 → 90 a moved claim rather than a
  // sentence with something appended. Without this pair the guard could satisfy
  // the 30→90 case with a "sets are disjoint" rule it should not have.
  test("a value change vetoes even when both statements share another number", async () => {
    const was = "the production service retains audit records for 30 days with 5 copies before cleanup";
    const is = "the production service retains audit records for 90 days with 5 copies before cleanup";
    expect(jac(sketchOf(was), sketchOf(is))).toBeGreaterThanOrEqual(NEAR_FLOOR);

    expect((await promote(was)).action).toBe("promoted");
    await prune("http", "decision", "wrong policy");
    const next = await promote(is);
    expect(next.action).toBe("promoted");
    expect((await loadAll()).map((m) => m.content)).toContain(is);
  });

  // The guard reads what the tombstone ASSERTED. Rows written before value
  // tracking assert nothing, so there is no evidence of a change and the
  // near-match stands as it shipped — pinned here along with the parser's
  // tolerance of the missing fields.
  test("a tombstone with no value signature degrades to the shipped behaviour", async () => {
    await writeRawTombstone(DAYS_WAS, "wrong policy");
    resetTombstoneCache();

    const row = (await tombstones())[0];
    expect(row.num).toBeUndefined();
    expect(row.pol).toBeUndefined();
    // No recorded values, so a numeric change is not evidence of a different
    // fact for THIS row. Documented degradation, not a silent hole: every row
    // written from now on carries both signatures.
    expect((await findRejection(DAYS_IS))?.kind).toBe("near");
    expect((await promote(DAYS_IS)).reason).toBe("previously_rejected");
  });
});

// The two dimensions in isolation, because the behavioral tests above only see
// them through a verdict, and everything in this table is a judgement the
// vocabulary makes rather than one the sketch makes.
describe("the value dimensions the sketch cannot see", () => {
  test("synonyms collapse to one sign; a flip changes it; negation composes", () => {
    expect(polaritySigns("the service must enable anonymous access")).toEqual(["pos"]);
    // A rewording with a different verb of the same sign is still the same claim.
    expect(polaritySigns("the service shall allow anonymous access")).toEqual(["pos"]);
    expect(polaritySigns("the service must disable anonymous access")).toEqual(["neg"]);
    // …and a reversal reached by negating the opposite verb is the REVERSAL, not
    // a new claim, which is why it still matches a rejected "disable".
    expect(polaritySigns("the service must not enable anonymous access")).toEqual(["neg"]);
    expect(polaritySigns("the flag is not disabled")).toEqual(["pos"]);
    // A copula keeps the negation alive across it; an ordinary word ends it.
    expect(polaritySigns("the flag must not be enabled")).toEqual(["neg"]);
    expect(polaritySigns("the flag was removed and enabled anyway")).toEqual(["neg", "pos"]);
    // Prose that asserts neither presence nor prohibition has no polarity, and
    // that is not the same as a row that recorded none (see differsIn).
    expect(polaritySigns("the service retains records for 30 days")).toEqual([]);
  });

  test("numeric tokens are the quantities, versions and ids in the sentence", () => {
    expect(numericTokens("retains records for 30 days")).toEqual(["30"]);
    expect(numericTokens("pinned to alpine 3.19 with 2 retries")).toEqual(["2", "3.19"]);
    expect(numericTokens("no numbers in this claim")).toEqual([]);
    expect(numericTokens("30 days, then 30 days again")).toEqual(["30"]);
  });

  test("a negator that is itself a polarity term composes instead of double-counting", () => {
    // "never" is BOTH a term in the table (it asserts a prohibition) and a word
    // that negates what follows it. Used as a negator it must contribute only the
    // flipped predicate, or "never disable" ends up asserting both signs and stops
    // matching the "enable" claim it restates.
    expect(polaritySigns("the service must never disable anonymous access")).toEqual(["pos"]);
    expect(polaritySigns("the service must never enable anonymous access")).toEqual(["neg"]);
    // Standalone — nothing in its span to negate — it still asserts the ban.
    expect(polaritySigns("the job never runs")).toEqual(["neg"]);
    expect(polaritySigns("we never allow it and never log it")).toEqual(["neg"]);
  });
});

// ---- Credential scrub at the tombstone boundary ----------------------------
//
// `reason` is the one field of a tombstone that is free prose, and it is the
// field copied into a model-facing refusal hint. The deletion audit has scrubbed
// recognized credentials at its own write boundary since #128; this file is a
// second durable record of the SAME human prose, written by a different call
// site (prune passes its raw reason straight through). Both destinations are
// pinned separately because they are separately reachable: the file on disk and
// the hint that replays it.
describe("a tombstone never carries an unscrubbed reason", () => {
  test("a credential in a forget reason is scrubbed on disk and in the replay hint", async () => {
    const token = "ghp_" + "a".repeat(36);
    // Premise: this is a family the scrubber recognizes, so a pass below that
    // finds the token is a leak and not simply an unrecognized string.
    expect(redactSecrets(token)).toBe(REDACTED_SECRET);

    expect((await promote(REJECTED)).action).toBe("promoted");
    await prune("http", "decision", `rotated ${token} for the deployment`);

    // Pre-existing boundary, unchanged.
    expect(readFileSync(join(memoryRoot(), "deletions.logfmt"), "utf8")).not.toContain(token);
    const rejected = readFileSync(rejectedFile(), "utf8");
    expect(rejected).not.toContain(token);

    const replay = await promote(REJECTED);
    expect(replay.reason).toBe("previously_rejected");
    expect(replay.hint ?? "").not.toContain(token);
    expect(replay.hint ?? "").toContain(REDACTED_SECRET);
  });

  // Defense in depth for a reason ALREADY on disk — written by an older build or
  // edited by hand: the read path is what feeds both the hint and the viewer.
  test("a reason already on disk unscrubbed is scrubbed on the way out", async () => {
    const token = "ghp_" + "b".repeat(36);
    await writeRawTombstone(REJECTED, `rotated ${token}`);
    resetTombstoneCache();

    expect(readFileSync(rejectedFile(), "utf8")).toContain(token); // premise: disk is dirty
    const row = (await tombstones())[0];
    expect(row.reason).not.toContain(token);
    expect((await promote(REJECTED)).hint ?? "").not.toContain(token);
  });
});

describe("lifting a rejection is a human action", () => {
  test("un-tombstone lets the value be stored again", async () => {
    const { ch } = await tombstone(REJECTED, { reason: "wrong call", source: "forget" });
    expect((await promote(REJECTED)).action).toBe("blocked");
    expect(await removeTombstone(ch)).toBe(true);
    expect((await promote(REJECTED)).action).toBe("promoted");
  });

  test("blocking tombstones the value; unblocking withdraws it", async () => {
    const first = await promote(REJECTED);
    expect(first.action).toBe("promoted");
    const ts = first.action === "promoted" ? first.ts : "";

    await blockMemory({ ts, reason: "poison" });
    expect(await tombstones()).toHaveLength(1);
    // The row is still on disk (block is non-destructive) but refused on the way in.
    expect((await promote(REJECTED)).action).toBe("blocked");

    await unblockMemory(ts);
    expect(await blockedEntries()).toHaveLength(0);
    expect(await tombstones()).toHaveLength(0);
    // Not `promoted`: the blocked row was never destroyed, so the identical
    // write collapses onto it (GATE-3 exact duplicate) rather than adding a
    // second copy. What matters is that it is no longer REFUSED.
    const after = await promote(REJECTED);
    expect(after.action).toBe("collapsed");
    expect(after.action).not.toBe("blocked");
  });

  test("no plugin tool can lift a rejection", async () => {
    const { ch } = await tombstone(REJECTED, { reason: "wrong call", source: "forget" });
    expect((await promote(REJECTED)).action).toBe("blocked");

    // Name scan first: nothing registered is even shaped like an un-reject.
    const names = Object.keys((await loadPlugin()).tool);
    expect(names.filter((n) => /unreject|tombstone|lift|approve/i.test(n))).toEqual([]);

    // Then the behavioral half: every IN-PROCESS tool is offered the most
    // plausible arguments it could take for clearing a tombstone, and none may
    // change the file. memory_init is excluded deliberately — it spawns the
    // external indexer (a child process, not a store mutation), which is what
    // tripped this test under the parallel test workers.
    const loaded = await loadPlugin();
    const invokable = names.filter((n) => n !== "memory_init");
    expect(invokable.length).toBeGreaterThan(8);
    const before = readFileSync(rejectedFile(), "utf8");
    for (const name of invokable) {
      await loaded.tool[name]
        .execute({ ch, ts: ch, scope: "http", type: "decision", reason: "lift", file: "x.jsonl" })
        .catch(() => undefined);
    }
    expect(readFileSync(rejectedFile(), "utf8")).toBe(before);
    expect((await promote(REJECTED)).action).toBe("blocked");
  });
});

function jac(a: string[], b: string[]): number {
  const sb = new Set(b);
  const inter = new Set(a.filter((x) => sb.has(x))).size;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * Append a tombstone line BY HAND, bypassing tombstoneMany, so a test can hold
 * the exact shape of a stored row: one written before the value signatures
 * existed (omit both), or one whose reason was never scrubbed.
 */
async function writeRawTombstone(
  content: string,
  reason: string,
  sigs: { num?: string[]; pol?: string[] } = {},
): Promise<void> {
  const file = rejectedFile();
  await mkdir(dirname(file), { recursive: true });
  await appendFile(
    file,
    `${formatLine({
      ch: contentHash(content),
      reason,
      source: "forget",
      rejected_at: new Date().toISOString(),
      sig: sketchOf(content).join("."),
      ...(sigs.num ? { num: sigs.num.join(".") } : {}),
      ...(sigs.pol ? { pol: sigs.pol.join(".") } : {}),
    })}\n`,
  );
}
