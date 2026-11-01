// Contract (follow-up review of #154/#155): an update's SUCCESS claims must be
// true at every exit, and the row an update replaces must be retired BY that
// update — not by a drift stamp from a parallel pass, not left active beside a
// silent replacement, and never reported as unwritten once a row is durable.
// The five-field carry from the #129 viewer precedent (issue, tags, kw, STATUS,
// REPO) is the fidelity rule: a prose edit may not launder a row's provenance,
// silently promote an open frontier row, or re-house a global row into the
// editor's repository. Every test here is red at 59f537e: markSuperseded's
// `false` was reported as success (the target drifted inside the same gate
// run, or a parallel writer retired it mid-call — then the retry claimed
// "Nothing was written" about a write that had happened), a messageless audit
// fault reported a clean Updated, the successor-duplicate verdict compared raw
// against redacted prose and swallowed metadata retries, and the carry stopped
// at three fields.
//
// Hermetic: temp OPENCODE_MEMORY_DIR / OPENCODE_COMMANDS_DIR, no network, no
// real home directory.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { appendMemory } from "../src/store/files/append.ts"
import { loadAll } from "../src/store/files/load.ts"
import { markManySuperseded } from "../src/store/files/supersede.ts";
import { resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";
import * as evidence from "../src/evidence/record.ts";

let root: string;
let a: string;
let b: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-supersede-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  plugins = [];
});

afterEach(async () => {
  for (const p of plugins) await p.cleanup();
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function plugin(dir: string): Promise<LoadedPlugin> {
  const p = await loadPlugin(dir);
  plugins.push(p);
  return p;
}
function stampOf(dir: string): { repo: string; repoPath: string } {
  const s = resolveRepo(dir);
  return { repo: s.key, repoPath: s.path };
}
const ctx = (sessionID: string) => ({ sessionID, id: "supersede" });
const active = () => loadAll().then((ms) => ms.filter((m) => !m.superseded_by));

describe("the row an update replaces is retired BY the update", () => {
  test("drift never stamps the update's own target: the supersede names the replacement", async () => {
    // GATE-2's drift pass scans every row of the scope — INCLUDING the row the
    // update is about to replace. Retiring it there (superseded_by = a chain
    // id) made markSuperseded a first-call-wins no-op, so the tool printed
    // "Updated ... (superseded T)" about a retirement it did not perform, and
    // the retry could not follow the chain id to the successor.
    writeFileSync(join(a, "table_manager.ts"), "export function save(config, opts) {\n  return [config, opts];\n}\n");
    const pa = await plugin(a);
    const T = await appendMemory({
      type: "pattern",
      scope: "ctl",
      content: "use table_manager.save(opts)",
      status: "open",
      ...stampOf(a),
    });
    const out = await pa.tools.memory_update.execute(
      { type: "pattern", scope: "ctl", query: T, content: "use table_manager.save(config, opts)", status: "open" },
      ctx("ses-drift"),
    );
    expect(out.content).toMatch(/^Updated pattern in ctl \(superseded /);
    const rows = await loadAll();
    const tRow = rows.find((m) => m.ts === T)!;
    const succ = (await active()).find((m) => m.content.includes("config, opts"))!;
    expect(tRow.reason).toBe("update");
    expect(tRow.superseded_by).toBe(succ.ts);
    // A retry of the same update reports the duplicate (not the dead-end
    // "no active row... Nothing was written" about a write that happened).
    const retry = await pa.tools.memory_update.execute(
      { type: "pattern", scope: "ctl", query: T, content: "use table_manager.save(config, opts)", status: "open" },
      ctx("ses-drift"),
    );
    expect(retry.content).toMatch(/was already updated to exactly this content/);
    expect(await active()).toHaveLength(1);
  });

  test("a target retired by a parallel writer mid-call reports PARTIAL, not Updated", async () => {
    // decay / memory_remember's gate / viewer retire rows WITHOUT the
    // update-order lock. When one lands between our resolution and our
    // markSuperseded, the boolean says "not by you" — and an honest success
    // line cannot be printed over it (#155's shape: two active rows, a
    // confident message, and a retry that claims nothing was ever written).
    const pa = await plugin(a);
    const T = await appendMemory({
      type: "context",
      scope: "planning",
      content: "Plan to prune aged queue entries every evening",
      status: "open",
      ...stampOf(a),
    });
    const D = await appendMemory({
      type: "context",
      scope: "planning",
      content: "Plan to prune aged queue entries on size pressure instead",
      status: "open",
      ...stampOf(a),
    });
    const record = evidence.record;
    let fired = false;
    const spy = spyOn(evidence, "record").mockImplementation(async (...args: Parameters<typeof record>) => {
      if (args[0] === "gate_start" && !fired) {
        fired = true;
        await markManySuperseded([
          { ts: T, fields: { superseded_by: D, reason: "canonical", entity: "queue pruning", from: "evening", to: "size" } },
        ]);
      }
      return record(...args);
    });
    let out: { content: string };
    try {
      out = await pa.tools.memory_update.execute(
        { type: "context", scope: "planning", query: T, content: "Plan to prune aged queue entries every morning", status: "open" },
        ctx("ses-race"),
      );
    } finally {
      spy.mockRestore();
    }
    expect(fired).toBe(true);
    expect(out.content).toMatch(/PARTIAL/);
    expect(out.content).toMatch(/IS on disk/);
    expect(out.content).not.toMatch(/Nothing was written/);
  });

  test("a messageless or non-Error audit fault cannot report a clean Updated", async () => {
    // The gate reports post-append audit failures on the outcome as
    // evidenceError; string-truthiness turned `new Error("")` and non-Error
    // rejections into a falsy lie — a full "Updated" with no write_promoted
    // line anywhere.
    for (const fault of [new Error(""), "disk full"]) {
      const pa = await plugin(a);
      const T = await appendMemory({
        type: "context",
        scope: "audit",
        content: `Row for the messageless-fault probe ${String(fault)}`,
        status: "open",
        ...stampOf(a),
      });
      const record = evidence.record;
      const spy = spyOn(evidence, "record").mockImplementation(async (...args: Parameters<typeof record>) => {
        if (args[0] === "write_promoted") throw fault;
        return record(...args);
      });
      let out: { content: string };
      try {
        out = await pa.tools.memory_update.execute(
          { type: "context", scope: "audit", query: T, content: `Row for the messageless-fault probe ${String(fault)}, revised`, status: "open" },
          ctx(`ses-fault-${typeof fault}`),
        );
      } finally {
        spy.mockRestore();
      }
      expect(out.content).toMatch(/PARTIAL/);
      // Proof the injection really landed: the audit line is missing even
      // though the replacement is durable.
      const ev = await pa.tools.memory_evidence.execute({ ev: "write_promoted", limit: 50 }, ctx(`ses-fault-${typeof fault}`));
      expect(ev.content).not.toContain("revised");
    }
  });
});

describe("the successor verdict tells the truth about content and metadata", () => {
  test("a retry whose successor holds the REDACTED prose reports the duplicate", async () => {
    // Rows pass the scrub on the way in; a retry re-carries the RAW prose, so
    // raw-vs-stored equality dead-ended exactly where #155's duplicate verdict
    // exists to land.
    const secret = `ghp_${"Ab3dE6fH9jK2mN5pQ8rT1uW4xY7zB0cD3eF6".slice(0, 36)}`;
    const pa = await plugin(a);
    const T = await appendMemory({
      type: "context",
      scope: "ops",
      content: "Deploy rotation notes are kept in the vault",
      status: "open",
      ...stampOf(a),
    });
    const withSecret = `Rotate the deploy token ${secret} every friday`;
    const out = await pa.tools.memory_update.execute(
      { type: "context", scope: "ops", query: T, content: withSecret, status: "open" },
      ctx("ses-red"),
    );
    expect(out.content).toMatch(/^Updated/);
    const retry = await pa.tools.memory_update.execute(
      { type: "context", scope: "ops", query: T, content: withSecret, status: "open" },
      ctx("ses-red"),
    );
    expect(retry.content).toMatch(/was already updated to exactly this content/);
    expect(await active()).toHaveLength(1);
  });

  test("the duplicate verdict leaves an evidence line", async () => {
    // Every other duplicate/block verdict writes a line; returning before the
    // gate silently broke the "every step is auditable" invariant while the
    // message told the model to consult memory_evidence.
    const pa = await plugin(a);
    const T = await appendMemory({
      type: "context",
      scope: "ev",
      content: "Ledger reconciliation runs before the daily standup",
      status: "open",
      ...stampOf(a),
    });
    const args = { type: "context", scope: "ev", query: T, content: "Ledger reconciliation runs after the daily standup", status: "open" };
    const out = await pa.tools.memory_update.execute(args, ctx("ses-ev"));
    expect(out.content).toMatch(/^Updated/);
    const before = await pa.tools.memory_evidence.execute({ limit: 200 }, ctx("ses-ev"));
    const retry = await pa.tools.memory_update.execute(args, ctx("ses-ev"));
    expect(retry.content).toMatch(/was already updated to exactly this content/);
    const after = await pa.tools.memory_evidence.execute({ limit: 200 }, ctx("ses-ev"));
    expect(after.content.length).toBeGreaterThan(before.content.length);
    const succ = (await active())[0];
    const dedup = await pa.tools.memory_evidence.execute({ ev: "dedup_collapse", limit: 50 }, ctx("ses-ev"));
    expect(dedup.content).toContain(succ.ts);
  });

  test("same successor prose with different metadata is an edit on the chain head, not a duplicate", async () => {
    // "Already updated to exactly this content" was claimed for content-only
    // equality — and a retry that also named new retrieval keywords had its
    // kw silently dropped. Metadata differing means the update still has work
    // to do: it runs against the live successor.
    const pa = await plugin(a);
    const T = await appendMemory({
      type: "context",
      scope: "kw",
      content: "Payment retries back off exponentially",
      status: "open",
      ...stampOf(a),
    });
    const first = await pa.tools.memory_update.execute(
      { type: "context", scope: "kw", query: T, content: "Payment retries back off exponentially by two", status: "open" },
      ctx("ses-kw"),
    );
    expect(first.content).toMatch(/^Updated/);
    const succ = (await active())[0];
    const retry = await pa.tools.memory_update.execute(
      { type: "context", scope: "kw", query: T, content: "Payment retries back off exponentially by two", status: "open", kw: ["billing"] },
      ctx("ses-kw"),
    );
    expect(retry.content).toMatch(/^Updated/);
    expect(retry.content).not.toMatch(/Duplicate/);
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0].kw).toEqual(["billing"]);
    expect(rows[0].ts).not.toBe(succ.ts);
    expect((await loadAll()).find((m) => m.ts === succ.ts)!.superseded_by).toBeTruthy();
  });

  test("a metadata edit lands while the prose is restated verbatim", async () => {
    // GATE-3's exact rule cannot see metadata: same content + new keywords
    // collapsed as a duplicate, so the tool could never edit kw at all.
    const pa = await plugin(a);
    const T = await appendMemory({
      type: "context",
      scope: "edit",
      content: "Feature flags live in the launch board, not code",
      status: "open",
      kw: ["oldalias"],
      ...stampOf(a),
    });
    const out = await pa.tools.memory_update.execute(
      { type: "context", scope: "edit", query: T, content: "Feature flags live in the launch board, not code", status: "open", kw: ["launchboard"] },
      ctx("ses-meta"),
    );
    expect(out.content).toMatch(/^Updated/);
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0].kw).toEqual(["launchboard"]);
    expect(rows[0].content).toBe("Feature flags live in the launch board, not code");
  });

  test("an update whose prose already stands elsewhere consolidates instead of ignoring", async () => {
    // The retry after a supersede-step fault collapsed here; a bare
    // "Duplicate ignored" left the named row active beside its replacement
    // forever. Completing the retirement is idempotent (first-call-wins) and
    // ends with one active statement either way.
    const pa = await plugin(a);
    const A = await appendMemory({
      type: "context",
      scope: "cons",
      content: "Search index rebuilds nightly from the primary shard",
      status: "open",
      ...stampOf(a),
    });
    const B = await appendMemory({
      type: "context",
      scope: "cons",
      content: "Search index rebuilds hourly from the replica",
      status: "open",
      ...stampOf(a),
    });
    const out = await pa.tools.memory_update.execute(
      { type: "context", scope: "cons", query: A, content: "Search index rebuilds hourly from the replica", status: "open" },
      ctx("ses-cons"),
    );
    expect(out.content).toContain(B);
    expect(out.content).toMatch(/retired in its favor/);
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0].ts).toBe(B);
  });

  test("a retry converges to one active row after the supersede step throws", async () => {
    const pa = await plugin(a);
    const T = await appendMemory({
      type: "context",
      scope: "h2",
      content: "Certificate rotation is automated by the renewal job",
      status: "open",
      ...stampOf(a),
    });
    const memory = await import("../src/store/files/supersede.ts");
    const mark = memory.markSuperseded;
    const spy = spyOn(memory, "markSuperseded").mockImplementationOnce(() => {
      throw new Error("simulated retirement fault");
    });
    let first: { content: string };
    try {
      first = await pa.tools.memory_update.execute(
        { type: "context", scope: "h2", query: T, content: "Certificate rotation is automated by certbot", status: "open" },
        ctx("ses-h2"),
      );
    } finally {
      spy.mockRestore();
    }
    expect(first.content).toMatch(/PARTIAL/);
    expect(first.content).toMatch(/merge or force/);
    const retry = await pa.tools.memory_update.execute(
      { type: "context", scope: "h2", query: T, content: "Certificate rotation is automated by certbot", status: "open" },
      ctx("ses-h2"),
    );
    expect(retry.content).toMatch(/retired in its favor/);
    expect(await active()).toHaveLength(1);
  });
});

describe("an update carries the row's standing with its prose", () => {
  test("a prose edit keeps an open row open", async () => {
    // status was reset on every prose edit: an open frontier row came back
    // settled, and memory_status's open count dropped without anyone closing
    // anything. (The #129 viewer precedent carries five fields; this carried
    // three.)
    const pa = await plugin(a);
    const T = await appendMemory({
      type: "context",
      scope: "frontier",
      content: "The flaky upload progress bar resizes on slow uplinks",
      status: "open",
      ...stampOf(a),
    });
    const out = await pa.tools.memory_update.execute(
      { type: "context", scope: "frontier", query: T, content: "The flaky upload progress bar resizes on slow uplinks, capped at 4 MB" },
      ctx("ses-open"),
    );
    expect(out.content).toMatch(/^Updated/);
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open");
    expect(rows[0].superseded_by ?? undefined).toBeUndefined();
  });

  test("updating a global row keeps it global for every other repository", async () => {
    // The successor was stamped from the CALLER's ambient repo: editing a
    // cross-project preference from one machine silently moved it out of
    // every other machine's view — README's "follow you everywhere" promise,
    // reversed by a typo fix.
    const pa = await plugin(a);
    const pb = await plugin(b);
    const G = await appendMemory({
      type: "preference",
      scope: "prefs",
      content: "Prefers concise answers with code first",
      status: "open",
      repo: "global",
    });
    const out = await pa.tools.memory_update.execute(
      { type: "preference", scope: "prefs", query: G, content: "Prefers concise answers with code first, tests second", status: "open" },
      ctx("ses-global"),
    );
    expect(out.content).toMatch(/^Updated/);
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe("global");
    const fromB = await pb.tools.memory_recall.execute({ scope: "prefs", query: "concise" }, ctx("ses-other"));
    expect(fromB.content).toMatch(/Found 1/);
  });

  test("carried metadata keeps the issue link and provenance tags", async () => {
    // The original #154 rule, re-pinned across the widened carry.
    const pa = await plugin(a);
    const T = await appendMemory({
      type: "learning",
      scope: "prov",
      content: "Migrated session tables via import [via import]",
      status: "open",
      tags: ["import"],
      issue: "PROJ-7",
      kw: ["migration"],
      ...stampOf(a),
    });
    const out = await pa.tools.memory_update.execute(
      { type: "learning", scope: "prov", query: T, content: "Migrated session tables via import [via import], verified", status: "open" },
      ctx("ses-prov"),
    );
    expect(out.content).toMatch(/^Updated/);
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0].tags).toEqual(["import"]);
    expect(rows[0].issue).toBe("PROJ-7");
    expect(rows[0].kw).toEqual(["migration"]);
  });
});
