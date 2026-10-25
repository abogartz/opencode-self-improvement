// #45 through the shipped tool: memory_consolidate proposes, reports, and never
// writes. The store before and after the call must be byte-identical.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRoot } from "../src/config.ts";
import { appendMemory, loadAll } from "../src/memory.ts";
import { recordHits } from "../src/hits.ts";
import { loadPlugin } from "./harness.ts";
import { resetState } from "../src/state.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-consol-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  mkdirSync(memoryRoot(), { recursive: true });
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const A = "the arm64 build box compiles the flimflam pipeline with bun build and no extra flags";
const B = "the arm64 build box compiles the flimflam pipeline with bun build without extra flags at all";
const C = "finance reconciles the zebra brasserie ledger nightly and mails a digest before opening bell";

describe("memory_consolidate tool (#45)", () => {
  test("it proposes the near-duplicates and leaves the store byte-identical", async () => {
    const p = await loadPlugin(process.cwd());
    for (const content of [A, B, C]) {
      await appendMemory({ type: "learning", scope: "build", content, status: "settled" });
    }
    // Give the cluster a read history, or the acceptance rule refuses to judge
    // it on resemblance alone (which is the whole point of the rule).
    const rows = await loadAll();
    const ab = rows.filter((m) => m.content === A || m.content === B);
    await recordHits("recall", "ses_con", ab, ["arm64", "build", "box", "flimflam"]);

    const before = await loadAll();
    const rep = await p.tools.memory_consolidate!.execute({});

    expect(rep.content).toContain("nothing was written");
    expect(rep.content).toContain("2 rows → 1");
    expect(rep.content).toContain("memory_merge_review(");
    // The unrelated row is not in any proposal.
    expect(rep.content).not.toContain("zebra");
    // And the store is untouched: same rows, same order, same supersession.
    const after = await loadAll();
    expect(after.length).toBe(before.length);
    expect(after.map((m) => `${m.ts}:${m.superseded_by ?? "-"}`)).toEqual(
      before.map((m) => `${m.ts}:${m.superseded_by ?? "-"}`),
    );
  });

  test("with no read history it reports unmeasured clusters rather than proposing", async () => {
    const p = await loadPlugin(process.cwd());
    await appendMemory({ type: "learning", scope: "build", content: A, status: "settled" });
    await appendMemory({ type: "learning", scope: "build", content: B, status: "settled" });
    const rep = await p.tools.memory_consolidate!.execute({});
    expect(rep.content).toContain("none");
    expect(rep.content).not.toContain("memory_merge_review(");
  });

  test("scope limits the pass to the rows you asked about", async () => {
    const p = await loadPlugin(process.cwd());
    await appendMemory({ type: "learning", scope: "build", content: A, status: "settled" });
    await appendMemory({ type: "learning", scope: "build", content: B, status: "settled" });
    await appendMemory({ type: "learning", scope: "finance", content: C, status: "settled" });
    const rows = await loadAll();
    await recordHits("recall", "ses_c2", rows.filter((m) => m.scope === "build"), ["arm64", "build", "box"]);
    const rep = await p.tools.memory_consolidate!.execute({ scope: "finance" });
    expect(rep.content).toContain("none");
  });
});
