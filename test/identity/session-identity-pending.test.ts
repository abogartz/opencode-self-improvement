//follow-up: awaiting identity must also await a lookup already in flight.
// These deterministic stalls exercise host interleavings, not a recorded host race.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  resetSessionScopes,
  resolveRepo,
  sessionDir,
  sessionDirFirm,
  setRepoScope,
} from "../../src/identity/repokey.ts";
import { createSessionContext } from "../../src/identity/session-context.ts";
import { appendMemory } from "../../src/store/files/append.ts";
import { loadAll } from "../../src/store/files/load.ts";
import { snapshotFiles } from "../../src/store/files/snapshots.ts";
import { type LoadedPlugin, loadPlugin, withTempStore } from "../harness.ts";

const store = withTempStore({ prefix: "osi-pending-identity-" });
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("pending session identity", () => {
  let a: string;
  let b: string;
  let plugins: LoadedPlugin[];
  let releases: Array<() => void>;
  let calls: Promise<unknown>[];

  beforeEach(() => {
    a = join(store.root, "repo-a");
    b = join(store.root, "repo-b");
    mkdirSync(a);
    mkdirSync(b);
    resetSessionScopes();
    setRepoScope(null);
    plugins = [];
    releases = [];
    calls = [];
  });

  afterEach(async () => {
    for (const release of releases) release();
    await Promise.allSettled(calls);
    for (const plugin of plugins) await plugin.cleanup();
    resetSessionScopes();
    setRepoScope(null);
  });

  function track<T>(promise: Promise<T>): Promise<T> {
    calls.push(promise);
    return promise;
  }

  function parked<T>(result: T, fail = false) {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<T>();
    const release = () =>
      fail
        ? pending.reject(new Error("host lookup failed"))
        : pending.resolve(result);
    releases.push(release);
    // The harness accepts unknown host responses. Promise assimilation parks its
    // async fake until release, and signals exactly when that fake is entered.
    const value = {
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable signals when the async host fake awaits it.
      then(
        resolve: (value: T) => unknown,
        reject: (reason: unknown) => unknown,
      ) {
        started.resolve();
        return pending.promise.then(resolve, reject);
      },
    };
    return { value, started: started.promise, release };
  }

  test.each(["messages", "row", "event-row"] as const)(
    "joins a pending %s lookup before returning identity",
    async (phase) => {
      const sid = `ses-pending-${phase}`;
      const lookup = parked(b);
      let lookups = 0;
      const directories = {
        async fromTranscript() {
          expect(this).toBe(directories);
          if (phase !== "messages") return undefined;
          lookups++;
          return lookup.value;
        },
        async fromSession() {
          expect(this).toBe(directories);
          lookups++;
          return lookup.value;
        },
      };
      const identity = createSessionContext(directories, {
        instanceDir: a,
        liveRoot: a,
      });
      identity.toolIds({ sessionID: sid });
      const first = track(
        phase === "event-row"
          ? identity.bindSessionFromApi(sid)
          : identity.bindSessionIdentity(sid),
      );
      await lookup.started;
      let settled = false;
      const second = track(
        identity.bindSessionIdentity(sid).then(() => {
          settled = true;
        }),
      );
      // Drain runnable continuations while the host remains explicitly parked.
      await nextTurn();
      expect(settled).toBe(false);
      expect(lookups).toBe(1);
      lookup.release();
      await Promise.all([first, second]);
      expect(sessionDirFirm(sid)).toBe(b);
    },
  );

  test.each([false, true])(
    "shares a pending row miss (throw=%s), retaining the completed-attempt cache",
    async (fail) => {
      const sid = "ses-pending-miss";
      const lookup = parked(undefined, fail);
      let lookups = 0;
      let messages = 0;
      const identity = createSessionContext(
        {
          async fromTranscript() {
            messages++;
            return undefined;
          },
          async fromSession() {
            lookups++;
            return lookup.value;
          },
        },
        { instanceDir: a, liveRoot: a },
      );
      const first = track(identity.bindSessionFromApi(sid));
      await lookup.started;
      let settled = false;
      const second = track(
        identity.bindSessionIdentity(sid).then(() => {
          settled = true;
        }),
      );
      await nextTurn();
      expect(settled).toBe(false);
      lookup.release();
      await Promise.all([first, second]);
      expect(sessionDirFirm(sid)).toBeUndefined();
      expect(sessionDir(sid)).toBe(a);
      await identity.bindSessionIdentity(sid);
      expect(lookups).toBe(1);
      expect(messages).toBe(2); // Message misses remain retryable, unlike row misses.
    },
  );

  async function plugin() {
    const p = await loadPlugin(a);
    plugins.push(p);
    return p;
  }

  async function seed(content: string) {
    const scope = resolveRepo(a);
    return appendMemory({
      type: "context",
      scope: "planning",
      content,
      status: "open",
      repo: scope.key,
      repoPath: scope.path,
    });
  }

  test.each(["messages", "row"] as const)(
    "concurrent merges cannot retire foreign rows during the %s lookup",
    async (phase) => {
      const p = await plugin();
      const sid = `ses-merge-${phase}`;
      const survivor = await seed("PENDING_WINNER");
      const loser = await seed("PENDING_LOSER");
      const lookup = parked(
        phase === "messages"
          ? [{ location: { directory: b } }]
          : { location: { directory: b } },
      );
      if (phase === "messages") p.capture.context.messages = lookup.value;
      else p.capture.session.row = lookup.value;
      const args = {
        loser,
        survivor,
        reason: "pending identity isolation probe",
      };
      const first = track(
        p.tools.memory_merge_review.execute(args, {
          sessionID: sid,
          id: "first",
        }),
      );
      await lookup.started;
      const second = track(
        p.tools.memory_merge_review.execute(args, {
          sessionID: sid,
          id: "second",
        }),
      );
      await nextTurn();
      lookup.release();
      const results = await Promise.all([first, second]);
      for (const result of results)
        expect(result.content).toContain("another repository");
      expect(
        (await loadAll()).find((row) => row.ts === loser)?.superseded_by,
      ).toBeUndefined();
      expect(p.capture.session.getCalls.length).toBe(
        phase === "messages" ? 0 : 1,
      );
    },
  );

  test("concurrent merges still succeed after the shared lookup confirms their own repository", async () => {
    const p = await plugin();
    const sid = "ses-pending-own";
    const survivor = await seed("OWN_WINNER");
    const loser = await seed("OWN_LOSER");
    const otherLoser = await seed("OWN_OTHER_LOSER");
    const lookup = parked({ location: { directory: a } });
    p.capture.session.row = lookup.value;
    const first = track(
      p.tools.memory_merge_review.execute(
        { loser, survivor, reason: "dupes" },
        { sessionID: sid },
      ),
    );
    await lookup.started;
    const second = track(
      p.tools.memory_merge_review.execute(
        { loser: otherLoser, survivor, reason: "dupes" },
        { sessionID: sid },
      ),
    );
    await nextTurn();
    lookup.release();
    for (const result of await Promise.all([first, second]))
      expect(result.content).toContain("Resolved merge");
    const rows = await loadAll();
    for (const ts of [loser, otherLoser])
      expect(rows.find((row) => row.ts === ts)?.superseded_by).toBe(survivor);
    expect(p.capture.session.getCalls).toEqual([sid]);
  });

  test("forget joins a row lookup started by another caller before capturing its reader", async () => {
    const p = await plugin();
    const sid = "ses-pending-forget";
    const survivor = await seed("FORGET_WINNER");
    const loser = await seed("FORGET_LOSER");
    const lookup = parked({ location: { directory: b } });
    p.capture.session.row = lookup.value;
    const first = track(
      p.tools.memory_merge_review.execute(
        { loser, survivor, reason: "probe" },
        { sessionID: sid },
      ),
    );
    await lookup.started;
    const second = track(
      p.tools.memory_forget.execute(
        { scope: "planning", type: "context", reason: "probe" },
        { sessionID: sid },
      ),
    );
    await nextTurn();
    lookup.release();
    await first;
    expect((await second).content).toContain("No memories found");
    expect((await loadAll()).map((row) => row.ts)).toEqual(
      expect.arrayContaining([loser, survivor]),
    );
  });

  test("force undo preserves foreign additions while another caller resolves identity", async () => {
    const p = await plugin();
    const sid = "ses-pending-undo";
    const survivor = await seed("UNDO_BASELINE");
    const baseline = (await loadAll()).find((row) => row.ts === survivor);
    if (!baseline) throw new Error("missing seeded undo baseline");
    const [snapshot] = await snapshotFiles([baseline.file]);
    if (!snapshot) throw new Error("missing undo snapshot");
    const loser = await seed("UNDO_FOREIGN_ADDITION");
    const lookup = parked({ location: { directory: b } });
    p.capture.session.row = lookup.value;
    const first = track(
      p.tools.memory_merge_review.execute(
        { loser, survivor, reason: "probe" },
        { sessionID: sid },
      ),
    );
    await lookup.started;
    const second = track(
      p.tools.memory_undo.execute(
        { snapshot: basename(snapshot), force: true },
        { sessionID: sid },
      ),
    );
    await nextTurn();
    lookup.release();
    await first;
    expect((await second).content).toContain(
      "belonging to other repositories untouched",
    );
    expect((await loadAll()).some((row) => row.ts === loser)).toBe(true);
  });
});
