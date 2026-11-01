// BDD integration suite: drives the REAL opencode terminal host against the
// scripted fake model, with a fresh isolated store per scenario. Every Given/
// When/Then is an actual `opencode run` turn — tool registration, write
// gates, and store files are asserted exactly as a user would observe them.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPO, type Fake, type Guest, makeGuest, startFake, turn } from "./support/harness.ts";

let fake: Fake;
const guests: Guest[] = [];

beforeAll(async () => {
  fake = await startFake();
});

afterEach(() => {
  for (const g of guests.splice(0)) rmSync(g.root, { recursive: true, force: true });
});

afterAll(() => fake.stop());

function guest(): Guest {
  const g = makeGuest(fake, REPO);
  guests.push(g);
  return g;
}

/** A scripted assistant tool_call step. `args` is the tool-call JSON object. */
function call(id: string, tool: string, args: Record<string, unknown>) {
  return { tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] };
}

const FACT =
  "the flimflam widget pipeline on the arm64 build box compiles with bun build using the " +
  "standard tsconfig defaults in single pass mode without any extra flags at all today";
const NEAR_DUPE = FACT.replace("today", "weekly"); // ~0.93 jaccard overlap, one token apart

function canonicalLines(memoryDir: string): string[] {
  // Active store = dated root logfmt files (canonical.logfmt is legacy);
  // deletions.logfmt is the audit trail, not live rows.
  return readdirSync(memoryDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.logfmt$/.test(f))
    .flatMap((f) => readFileSync(join(memoryDir, f), "utf8").trim().split("\n").filter(Boolean));
}

describe("Feature: durable memory store over the terminal", () => {
  test("Scenario: a fresh store starts empty", async () => {
    // Given a brand-new isolated instance
    const g = guest();
    fake.setSteps({ "SMOKE::list": [call("c1", "memory_list", {}), { content: "LIST-DONE" }] });

    // When asking what memories exist
    const run = await turn(fake, g, "SMOKE::list what memories do we have?");

    // Then the turn is healthy and the store reports nothing
    expect(run.exit).toBe(0);
    expect(run.errors()).toEqual([]);
    expect(run.outputs("memory_list")[0]).toInclude("No memories");
    expect(canonicalLines(g.memoryDir)).toEqual([]);
  });

  // @covers hook:session.context hook:session.prompt hook:event.subscribe
  test("Scenario: remember stores a fact and a new session sees it", async () => {
    // Given a fresh instance where the agent stores one frontier fact
    const g = guest();
    fake.setSteps({
      "SMOKE::add": [
        call("a1", "memory_remember", {
          type: "learning",
          scope: "flimflam",
          content: FACT,
          status: "open",
        }),
        { content: "ADD-DONE" },
      ],
    });
    const add = await turn(fake, g, "SMOKE::add please store this fact: " + FACT);

    // When the fact lands, the write gate promotes it and it hits the store
    expect(add.exit).toBe(0);
    expect(add.errors()).toEqual([]);
    expect(add.outputs("memory_remember")[0]).toInclude("Remembered");
    expect(canonicalLines(g.memoryDir).length).toBe(1);

    // When a brand-new session (second host process, same store) recalls it
    fake.setSteps({
      "SMOKE::recall": [call("r1", "memory_recall", { query: "flimflam widget" }), { content: "RECALL-DONE" }] },
    );
    const recall = await turn(fake, g, "SMOKE::recall what do we know about flimflam widget builds?");
    expect(recall.exit).toBe(0);
    expect(recall.outputs("memory_recall")[0]).toInclude("flimflam");

    // And the epoch injection surfaced the fact in the system prompt itself
    const reqs = await fake.requests();
    const agentReq = reqs.find((b: any) => Array.isArray(b.tools) && b.tools.length);
    const sys = (agentReq?.messages ?? [])
      .filter((m: any) => m.role === "system" || m.role === "developer")
      .map((m: any) => String(m.content))
      .join("\n");
    expect(sys).toInclude("flimflam");
  });

  test("Scenario: an exact duplicate collapses instead of double-storing", async () => {
    // Given a fresh instance
    const g = guest();
    const remember = (id: string) =>
      call(id, "memory_remember", { type: "learning", scope: "flimflam", content: FACT, status: "open" });
    fake.setSteps({ "SMOKE::dupe": [remember("d1"), remember("d2"), { content: "DUPE-DONE" }] });

    // When the same fact is restated byte-for-byte
    const run = await turn(fake, g, "SMOKE::dupe store this and then store it again: " + FACT);

    // Then the second write collapses and the store holds exactly one row
    expect(run.exit).toBe(0);
    const outs = run.outputs("memory_remember");
    expect(outs.length).toBe(2);
    expect(outs[0]).toInclude("Remembered");
    expect(outs[1]).toInclude("Duplicate ignored");
    expect(canonicalLines(g.memoryDir).length).toBe(1);
  });

  test("Scenario: a near duplicate is review-gated, not silently stored", async () => {
    // Given a fresh instance holding FACT
    const g = guest();
    const remember = (id: string, content: string) =>
      call(id, "memory_remember", { type: "learning", scope: "flimflam", content, status: "open" });
    fake.setSteps({
      "SMOKE::near": [remember("n1", FACT), remember("n2", NEAR_DUPE), { content: "NEAR-DONE" }],
    });

    // When a heavy-overlap paraphrase arrives
    const run = await turn(fake, g, "SMOKE::near store this fact and then this near-identical restatement");

    // Then the paraphrase is blocked at the overlap gate for merge review
    expect(run.exit).toBe(0);
    const outs = run.outputs("memory_remember");
    expect(outs[0]).toInclude("Remembered");
    expect(outs[1]).toMatch(/^Write blocked at GATE \(superseded_overlap\)/);
    expect(canonicalLines(g.memoryDir).length).toBe(1);
    // And the rivalry is recorded as evidence for the merge-review tools
    const evDir = join(g.memoryDir, "evidence");
    const ev = existsSync(evDir)
      ? readdirSync(evDir).map((f) => readFileSync(join(evDir, f), "utf8")).join("\n")
      : "";
    expect(ev).toInclude("merge_proposal");
  });

  test("Scenario: an ungrounded settled claim is blocked as ambiguous", async () => {
    // Given a fresh instance with no in-session evidence
    const g = guest();
    fake.setSteps({
      "SMOKE::vague": [
        call("v1", "memory_remember", {
          type: "learning",
          scope: "flimflam",
          content: "flimflam probably uses tarballs for releases because that is typical",
        }),
        { content: "VAGUE-DONE" },
      ],
    });

    // When a settled (non-frontier) claim arrives with no refs or engagement
    const run = await turn(fake, g, "SMOKE::vague save this learning about flimflam releases");

    // Then the gate refuses it and records evidence instead of a row
    expect(run.exit).toBe(0);
    expect(run.outputs("memory_remember")[0]).toMatch(/^Write blocked at GATE \(ambiguous_memory\)/);
    expect(canonicalLines(g.memoryDir)).toEqual([]);
  });

  test("Scenario: forget deletes and the audit trail survives", async () => {
    // Given a fresh instance holding FACT
    const g = guest();
    const remember = call("f1", "memory_remember", {
      type: "learning",
      scope: "flimflam",
      content: FACT,
      status: "open",
    });
    fake.setSteps({
      "SMOKE::forget": [
        remember,
        call("f2", "memory_forget", { scope: "flimflam", type: "learning", reason: "e2e scenario cleanup" }),
        call("f3", "memory_recall", { query: "flimflam widget" }),
        { content: "FORGET-DONE" },
      ],
    });

    // When the fact is forgotten and searched again
    const run = await turn(fake, g, "SMOKE::forget store the flimflam fact, delete it, then search again");

    // Then one row was deleted, recall comes up empty, and the audit log stands
    expect(run.exit).toBe(0);
    expect(run.outputs("memory_remember")[0]).toInclude("Remembered");
    expect(run.outputs("memory_forget")[0]).toInclude("Deleted 1");
    expect(run.outputs("memory_recall")[0]).not.toInclude("flimflam widget pipeline");
    expect(existsSync(join(g.memoryDir, "deletions.logfmt"))).toBe(true);
  });
});
