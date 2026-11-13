// Probe for #154: a prose edit via memory_update must not silently discard
// the target's provenance. The replacement candidate was built from args
// alone, so an update of an imported/auto-captured row stripped the
// tags:["import"] marker (and issue/kw), laundering unverified source
// material into ordinary memory — the update-tool twin of the viewer-edit
// preservation fixed in #129.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { loadAll } from "../src/store/files/load.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { seedPlanRow } from "./helpers/scenario-builders.ts";
import { resetState } from "../src/core/state.ts";

let root: string;
let a: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-upmeta-"));
  a = join(root, "repo-a");
  mkdirSync(a);
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
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith("osi-upmeta-")
  ) {
    throw new Error("Unexpected fixture cleanup path");
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

async function plugin(dir: string | null) {
  const p = await loadPlugin(dir);
  plugins.push(p);
  return p;
}
const ctx = (sessionID: string) => ({ sessionID, id: "upmeta-proof" });

describe("memory_update preserves omitted metadata (#154)", () => {
  test("a prose edit keeps import provenance, issue, and keywords", async () => {
    const pa = await plugin(a);
    const original = await seedPlanRow(
      a,
      "Plan to prune aged queue entries every evening",
      {
        tags: ["import"],
        issue: "import-provenance-marker",
        kw: ["queue retention"],
      },
    );
    const result = await pa.tools.memory_update.execute(
      {
        type: "context",
        scope: "planning",
        query: original,
        content: "Plan to prune aged queue entries every morning",
        status: "open",
      },
      ctx("ses-a"),
    );
    expect(result.content).toContain("Updated");
    const replacement = (await loadAll()).find((m) =>
      m.content.includes("every morning"),
    )!;
    expect(replacement.tags ?? []).toContain("import");
    expect(replacement.issue).toBe("import-provenance-marker");
    expect(replacement.kw ?? []).toContain("queue retention");
  });

  test("a prose edit drops `restatable`: the verdict described the old text (#403)", async () => {
    // The tag asserts "the working tree states THIS prose". A correction changes
    // the prose, so the verdict no longer describes anything — and unlike a
    // merely wrong verdict, this one is wrong by construction while the row is
    // still demoted first under a binding budget. The user fixes a stale fact and
    // the fix is the row injection hides. Other provenance survives.
    const pa = await plugin(a);
    const original = await seedPlanRow(
      a,
      "The nightly prune job removes aged queue entries when they turn seven days old",
      { tags: ["auto-capture", "restatable"] },
    );
    const result = await pa.tools.memory_update.execute(
      {
        type: "context",
        scope: "planning",
        query: original,
        content:
          "The nightly prune job keeps aged queue entries for a fortnight before removing them",
        // "open" is the planning-object home this fixture uses: a settled claim
        // with no code refs and no in-session engagement is refused by GATE-4 for
        // reasons that have nothing to do with the tag under test.
        status: "open",
      },
      ctx("ses-a"),
    );
    expect(result.content).toContain("Updated");
    const replacement = (await loadAll()).find((m) =>
      m.content.includes("fortnight"),
    )!;
    expect(replacement.tags ?? []).not.toContain("restatable");
    expect(replacement.tags ?? []).toContain("auto-capture");
  });

  test("control: explicit kw replaces rather than unions", async () => {
    const pa = await plugin(a);
    const original = await seedPlanRow(
      a,
      "Rotate the nginx certificate by hand each quarter",
      { kw: ["old alias"] },
    );
    const result = await pa.tools.memory_update.execute(
      {
        type: "context",
        scope: "planning",
        query: original,
        content: "Renew the nginx certificate via the certbot timer",
        status: "open",
        kw: ["certbot"],
      },
      ctx("ses-a"),
    );
    expect(result.content).toContain("Updated");
    const replacement = (await loadAll()).find((m) =>
      m.content.includes("certbot timer"),
    )!;
    expect(replacement.kw ?? []).toContain("certbot");
    expect(replacement.kw ?? []).not.toContain("old alias");
  });
});
