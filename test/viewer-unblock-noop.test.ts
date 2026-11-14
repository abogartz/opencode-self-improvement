// #209: a no-op unblock must not withdraw another copy's value rejection.
// removeBlock/removeTombstone returned true and republished the file even when
// they filtered nothing, and unblockMemory lifted the value tombstone whenever
// the row existed — so a stale/direct /api/unblock on a never-blocked row A
// withdrew the rejection that still guarded a blocked identical copy B, letting
// the value be re-ingested. Probe reported at bf9f4d2; reproduced on main.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdentity } from "../src/core/logfmt/publish.ts";
import { resetState } from "../src/core/state.ts";
import { resetSessionScopes, setRepoScope } from "../src/identity/repokey.ts";
import { appendMemory } from "../src/store/files/append.ts";
import {
  blocklistFile,
  blockedEntries,
  removeBlock,
} from "../src/store/blocklist.ts";
import { rejectedFile } from "../src/store/tombstones/rejection.ts";
import {
  removeTombstone,
  tombstones,
} from "../src/store/tombstones/tombstone.ts";
import {
  blockMemory,
  unblockMemory,
  unrejectMemory,
} from "../src/viewer/mutate.ts";
import { startViewer, type ViewerServer } from "../src/viewer/server.ts";
import { removeStore } from "./helpers/remove-store.ts";

const CONTENT =
  "the deploy pipeline pins the base image digest and verifies the signature before pushing";

let root: string;
let viewer: ViewerServer;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "osi209-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  viewer = await startViewer(0);
});
afterEach(() => {
  viewer.server.stop(true);
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  removeStore(root);
});

async function post(
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(path, viewer.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

describe("#209 no-op blocklist and tombstone removal", () => {
  test("removeBlock reports false for an unknown ts and does not rewrite the file", async () => {
    const ts = await appendMemory({
      type: "learning",
      scope: "deploy",
      content: CONTENT,
    });
    await blockMemory({ ts, reason: "poisoned" });
    const before = await fileIdentity(blocklistFile());
    expect(await removeBlock("2000-01-01T00:00:00.000Z")).toBe(false);
    expect(await fileIdentity(blocklistFile())).toBe(before);
    expect(await blockedEntries()).toHaveLength(1);
  });

  test("removeTombstone and /api/unreject report false for an unknown ch and do not rewrite", async () => {
    const ts = await appendMemory({
      type: "learning",
      scope: "deploy",
      content: CONTENT,
    });
    await blockMemory({ ts, reason: "poisoned" });
    expect(await tombstones()).toHaveLength(1);
    const before = await fileIdentity(rejectedFile());
    expect(await removeTombstone("deadbeefdead")).toBe(false);
    expect(await unrejectMemory("deadbeefdead")).toBe(false);
    expect(await post("/api/unreject", { ch: "deadbeefdead" })).toEqual({
      unrejected: false,
    });
    expect(await fileIdentity(rejectedFile())).toBe(before);
    expect(await tombstones()).toHaveLength(1);
  });

  test("unblocking a never-blocked row leaves the blocked identical copy guarded", async () => {
    const a = await appendMemory({
      type: "learning",
      scope: "deploy",
      content: CONTENT,
    });
    const b = await appendMemory({
      type: "learning",
      scope: "ops",
      content: CONTENT,
    });
    await blockMemory({ ts: b, reason: "poisoned" });
    expect(await tombstones()).toHaveLength(1);

    expect(await unblockMemory(a)).toBe(false);
    expect(await post("/api/unblock", { ts: a })).toEqual({ unblocked: false });
    expect(await blockedEntries()).toHaveLength(1);
    expect(await tombstones()).toHaveLength(1);

    // Valid unblock still works and still lifts the shared value rejection —
    // the open question this ticket explicitly does NOT decide, so the
    // pre-existing behaviour is pinned, not changed.
    expect(await unblockMemory(b)).toBe(true);
    expect(await blockedEntries()).toHaveLength(0);
    expect(await tombstones()).toHaveLength(0);
  });
});
