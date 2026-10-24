// Repo scoping: memories belong to the repo that wrote them;
// global rows (explicit marker, or no stamp — legacy and unscoped writers)
// follow the user everywhere. Covers: the stamp at appendMemory, the single
// visibility predicate at every model-facing sink (injection, pull, digest,
// anchor, storeVersion), the tools (recall, list, update targeting, forget,
// decay), gate dedup, import/export carry-through, and the /repo-init stamp.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRepoScope } from "../src/repokey.ts";
import { normalizeRemote } from "../src/repokey.ts";
import { appendMemory, loadAll, prune } from "../src/memory.ts";
import { relevantKnowledge, systemDigest, storeVersion, contextualPull } from "../src/inject.ts";
import { findStaleOpen, importMemories, exportMemories } from "../src/portable.ts";
import { runWriteGate } from "../src/gates.ts";

const REPO_A = { key: "aaa111", path: "/work/alpha" };
const REPO_B = { key: "bbb222", path: "/work/beta" };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-reposcope-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(REPO_A);
});
afterEach(() => {
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const dayFile = () => join(process.env.OPENCODE_MEMORY_DIR!, `${new Date().toISOString().split("T")[0]}.logfmt`);

const knowledgeFor = async (prompt: string) => (await relevantKnowledge(prompt, 5)).toLowerCase();

describe("stamping (appendMemory)", () => {
  test("a write in repo A carries A's key and path on disk", async () => {
    await appendMemory({ type: "learning", scope: "s", content: "alpha fact about deploys here" });
    const raw = readFileSync(dayFile(), "utf8");
    expect(raw).toContain(`repo=${REPO_A.key}`);
    expect(raw).toContain(`repoPath=${REPO_A.path}`);
  });

  test('repo:"global" survives instead of being re-stamped', async () => {
    await appendMemory({ type: "preference", scope: "s", content: "user prefers terse answers globally ok", repo: "global" });
    const raw = readFileSync(dayFile(), "utf8");
    expect(raw).toContain("repo=global");
    expect(raw).not.toContain(REPO_A.key);
  });

  test("an unscoped process stamps nothing (viewer / legacy semantics)", async () => {
    setRepoScope(null);
    await appendMemory({ type: "learning", scope: "s", content: "written by the admin viewer ok" });
    const raw = readFileSync(dayFile(), "utf8");
    expect(raw).not.toContain("repo=");
  });
});

describe("visibility at the model-facing sinks", () => {
  test("injection: repo A row is invisible from B; global and unstamped rows are not", async () => {
    await appendMemory({ type: "pattern", scope: "billing-service", content: "Staging deploys require the VPN and make deploy-staging" });
    expect(await knowledgeFor("how do I deploy to staging?")).toContain("vpn");

    setRepoScope(REPO_B);
    const out = await knowledgeFor("how do I deploy to staging?");
    expect(out).not.toContain("vpn");

    await appendMemory({ type: "pattern", scope: "deploy", content: "global deploy habit: always read the runbook first", repo: "global" });
    expect(await knowledgeFor("how do I deploy to staging?")).toContain("runbook");

    // A raw legacy row (no repo field on disk) stays visible everywhere.
    const { appendLog, formatLine } = await import("../src/logfmt.ts");
    await appendLog(dayFile(), formatLine({ ts: "2025-01-01T00:00:00.000Z", type: "learning", scope: "ops", content: "legacy staging note from before scoping" }));
    expect(await knowledgeFor("how do I deploy to staging?")).toContain("legacy staging note");
  });

  test("frontier digest does not leak another repo's open thread", async () => {
    await appendMemory({ type: "context", scope: "alpha", content: "open alpha plan: rewrite the ingest pipeline", status: "open" });
    setRepoScope(REPO_B);
    const system: string[] = [];
    await systemDigest({ sessionID: "s1" }, { system });
    expect(system.join("\n")).not.toContain("ingest pipeline");
  });

  test("contextual pull on grep results is repo-scoped", async () => {
    await appendMemory({ type: "learning", scope: "alpha", content: "alpha uses table_manager.save for exports" });
    setRepoScope(REPO_B);
    const out = { output: "file.ts:12 match" };
    await contextualPull({ tool: "grep", args: { pattern: "table_manager.save" } }, out);
    expect(out.output).toBe("file.ts:12 match"); // no append
  });

  test("storeVersion ignores foreign-repo writes (no pointless epoch bust)", async () => {
    await appendMemory({ type: "learning", scope: "s", content: "a local row exists here now" });
    const v1 = await storeVersion();
    await appendMemory({ type: "learning", scope: "s", content: "a row stamped for another repo", repo: "zzz999" });
    expect(await storeVersion()).toBe(v1);
  });
});

describe("tools and admin paths", () => {
  test("memory_forget cannot delete another repo's same-name scope", async () => {
    await appendMemory({ type: "pattern", scope: "api", content: "alpha repo api convention: kebab routes" });
    setRepoScope(REPO_B);
    const res = await prune("api", "pattern", "cleanup in beta");
    expect(res.deleted).toHaveLength(0);
    setRepoScope(REPO_A);
    expect((await loadAll()).some((m) => m.scope === "api")).toBe(true);
  });

  test("decay does not retire another repo's open threads", async () => {
    await appendMemory({ type: "context", scope: "alpha", content: "ancient open thread in alpha about ingestion", status: "open" });
    // Backdate the row directly to make it stale.
    const raw = readFileSync(dayFile(), "utf8").replace(/ts=\S+/, "ts=2025-01-01T00:00:00.000Z");
    await Bun.write(dayFile(), raw);
    setRepoScope(REPO_B);
    expect(await findStaleOpen(14)).toHaveLength(0);
    setRepoScope(REPO_A);
    expect(await findStaleOpen(14)).toHaveLength(1);
  });

  test("gate dedup is repo-local: an identical global row collapses, a foreign row does not", async () => {
    const content = "run bun test before every merge, always green before ship";
    await appendMemory({ type: "pattern", scope: "shared", content, repo: "global" });
    const g = await runWriteGate(
      { type: "pattern", scope: "shared", content },
      { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true },
    );
    expect(g.action).toBe("collapsed");

    await appendMemory({ type: "pattern", scope: "other", content, repo: REPO_B.key, repoPath: REPO_B.path });
    const g2 = await runWriteGate(
      { type: "pattern", scope: "other", content },
      { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true },
    );
    // The foreign row must not collapse the write here...
    expect(g2.action).toBe("promoted");
    // ...and the promoted row carries THIS repo's stamp.
    const raw = readFileSync(dayFile(), "utf8");
    expect(raw).toContain(`repo=${REPO_A.key}`);
  });
});

describe("portability validates origin stamps", () => {
  test("export -> import in another repo replaces the foreign stamp with the importer's", async () => {
    await appendMemory({ type: "learning", scope: "s", content: "fact that must stay scoped to alpha" });
    const exp = await exportMemories({});
    setRepoScope(REPO_B);
    const tally = await importMemories(exp.path, async (c) => {
      const out = await runWriteGate(c, { liveRoot: root, evidenceCalls: [], hasGateCheck: true, trusted: true });
      return { action: out.action };
    });
    expect(tally.promoted + tally.collapsed).toBeGreaterThan(0);
    // The export's ALPHA stamp cannot choose a privileged destination. The
    // imported copy belongs to the repo where the user ran memory_import.
    const copies = (await loadAll()).filter((m) => m.content.includes("stay scoped to alpha"));
    expect(copies.some((m) => m.repo === REPO_A.key)).toBe(true);
    expect(copies.some((m) => m.repo === REPO_B.key && m.repoPath === REPO_B.path)).toBe(true);
  });
});

describe("normalizeRemote", () => {
  test("all common remote forms hash one repo to one id", () => {
    const forms = [
      "git@github.com:Owner/Repo.git",
      "https://GitHub.com/owner/repo.git",
      "https://github.com/owner/repo/",
      "ssh://git@github.com/owner/repo",
    ];
    const ids = new Set(forms.map(normalizeRemote));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe("github.com/owner/repo");
  });
});
