// Contract: per-session plugin state is bounded. SessionLru keeps the most
// recently used sessions and reports each eviction exactly once, so the
// plugin can drop every session-keyed map together (issue #75).
import { describe, expect, test } from "bun:test";
import { SessionLru } from "../src/core/lru.ts";

describe("SessionLru", () => {
  test("honors its cap, refreshes recency, and calls onEvict once per eviction", () => {
    const evicted: string[] = [];
    const sessions = new SessionLru(2, (sid) => evicted.push(sid));

    sessions.touch("oldest");
    sessions.touch("kept");
    sessions.touch("oldest"); // refresh recency: kept is now least recent
    sessions.touch("new");

    expect(sessions.size).toBe(2);
    expect(evicted).toEqual(["kept"]);

    sessions.touch("new"); // touching an existing session does not evict
    expect(sessions.size).toBe(2);
    expect(evicted).toEqual(["kept"]);

    sessions.touch("newest");
    expect(sessions.size).toBe(2);
    expect(evicted).toEqual(["kept", "oldest"]);
  });
});
