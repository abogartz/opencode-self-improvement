// The pure core of capture: candidate parsing, model-ref parsing, prompt
// assembly. All total functions - no store, no
// host, no clock - so each case is an input and the answer it must produce.
// parseCandidates rejects rather than repairs: a malformed candidate is dropped
// with a reason, never coerced into a row.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCandidates,
  parseModelRef,
} from "../../src/capture/candidates.ts";
import { resetCaptureCursors } from "../../src/capture/policy.ts";
import { buildCapturePrompt } from "../../src/capture/prompt.ts";

import { resetState } from "../../src/core/state.ts";
import { setRepoScope } from "../../src/identity/repokey.ts";
import { resetCaptureCooldowns, resetSessionModels } from "../../src/index.ts";
import { removeStore } from "../helpers/remove-store.ts";

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-capture-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  setRepoScope(null);
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  resetState();
  resetCaptureCooldowns(); // cooldown truth is module-level since the cooldown refactor - and bun test shares module state across files, so a fresh test needs this explicit clear
  resetSessionModels(); // same module-level truth for the session-model registry
  resetCaptureCursors(); // the delta cursor and signal window are module-level too
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  removeStore(root);
});

const GOOD = {
  type: "learning",
  scope: "build",
  content: "Run the full test suite with bun test from the repo root.",
};

describe("parseCandidates", () => {
  test("bare JSON array parses; fenced block parses; prose around it is ignored", () => {
    expect(parseCandidates(JSON.stringify([GOOD]), 3)).toEqual([GOOD]);
    const fenced = `Here you go:\n\`\`\`json\n${JSON.stringify([GOOD])}\n\`\`\`\nHope that helps!`;
    expect(parseCandidates(fenced, 3)).toEqual([GOOD]);
    expect(
      parseCandidates(`Sure! ${JSON.stringify([GOOD])} — enjoy`, 3),
    ).toEqual([GOOD]);
  });

  test("garbage, empty, and unbalanced input all yield [] (never throws)", () => {
    expect(parseCandidates("no array here", 3)).toEqual([]);
    expect(parseCandidates("", 3)).toEqual([]);
    expect(parseCandidates("   ", 3)).toEqual([]);
    expect(parseCandidates('[{"type":"learning"', 3)).toEqual([]); // truncated mid-array
    expect(parseCandidates("]] [[", 3)).toEqual([]);
    expect(parseCandidates(undefined as never, 3)).toEqual([]);
    expect(parseCandidates(123 as never, 3)).toEqual([]);
  });

  test("non-object items, unknown types, and missing fields are dropped", () => {
    expect(parseCandidates('[1, "x", null, [2]]', 3)).toEqual([]);
    expect(
      parseCandidates(JSON.stringify([{ ...GOOD, type: "wisdom" }]), 3),
    ).toEqual([]);
    expect(
      parseCandidates(
        JSON.stringify([{ type: GOOD.type, content: GOOD.content }]),
        3,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(
        JSON.stringify([{ type: GOOD.type, scope: GOOD.scope }]),
        3,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(JSON.stringify([{ ...GOOD, scope: "  " }]), 3),
    ).toEqual([]);
  });

  test("keywords ride along when the model supplies them", () => {
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, kw: ["bun test", "run the suite"] }]),
        3,
      ),
    ).toEqual([{ ...GOOD, kw: ["bun test", "run the suite"] }]);
  });

  test("a bad keyword list costs the keywords, never the row", () => {
    // Junk entries are dropped; the fact itself is what the session earned.
    expect(
      parseCandidates(
        JSON.stringify([
          { ...GOOD, kw: ["  Bun Test  ", "", 7, null, "x".repeat(60)] },
        ]),
        3,
      ),
    ).toEqual([{ ...GOOD, kw: ["bun test"] }]);
    for (const junk of ["not-an-array", 42, null, { a: 1 }, undefined]) {
      expect(
        parseCandidates(JSON.stringify([{ ...GOOD, kw: junk }]), 3),
      ).toEqual([GOOD]);
    }
    // Control characters would forge a field on the store line.
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, kw: ["ok", "two\nlines"] }]),
        3,
      ),
    ).toEqual([{ ...GOOD, kw: ["ok"] }]);
    // Capped, whatever the model decides to emit.
    const many = parseCandidates(
      JSON.stringify([
        { ...GOOD, kw: Array.from({ length: 20 }, (_, i) => `alias ${i}`) },
      ]),
      3,
    );
    expect(many[0]?.kw).toHaveLength(8);
  });

  test("control characters in structured fields are dropped", () => {
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, scope: "build\n## SYSTEM" }]),
        3,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, scope: "build\u2028forged" }]),
        3,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(JSON.stringify([{ ...GOOD, type: "learning\r" }]), 3),
    ).toEqual([]);
  });

  test("content outside 20-600 chars is dropped at the exact boundaries", () => {
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, content: "x".repeat(19) }]),
        3,
      ),
    ).toEqual([]);
    expect(
      parseCandidates(JSON.stringify([{ ...GOOD, content: "x".repeat(20) }]), 3)
        .length,
    ).toBe(1);
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, content: "x".repeat(600) }]),
        3,
      ).length,
    ).toBe(1);
    expect(
      parseCandidates(
        JSON.stringify([{ ...GOOD, content: "x".repeat(601) }]),
        3,
      ),
    ).toEqual([]);
  });

  test("status passes through only for open/settled; anything else becomes undefined", () => {
    const open = parseCandidates(
      JSON.stringify([{ ...GOOD, status: "open" }]),
      3,
    );
    expect(open[0].status).toBe("open");
    const junk = parseCandidates(
      JSON.stringify([{ ...GOOD, status: "pending" }]),
      3,
    );
    expect(junk[0].status).toBeUndefined();
  });

  test("clamps to max; max <= 0 yields []", () => {
    const three = [
      GOOD,
      { ...GOOD, content: "A second durable fact about the build pipeline." },
      { ...GOOD, content: "A third durable fact worth keeping around." },
    ];
    expect(parseCandidates(JSON.stringify(three), 2).length).toBe(2);
    expect(parseCandidates(JSON.stringify(three), 3).length).toBe(3);
    expect(parseCandidates(JSON.stringify(three), 0)).toEqual([]);
    expect(parseCandidates(JSON.stringify(three), -1)).toEqual([]);
  });
});

// --- parseModelRef ------------------------------------------------------------

describe("parseModelRef", () => {
  test("splits on the FIRST slash", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4",
    });
    expect(parseModelRef("a/b/c")).toEqual({ providerID: "a", id: "b/c" });
  });

  test("no slash or empty half -> null (capture is skipped, not guessed)", () => {
    expect(parseModelRef("noslash")).toBeNull();
    expect(parseModelRef("/only-id")).toBeNull();
    expect(parseModelRef("prov/")).toBeNull();
    expect(parseModelRef("prov/ ")).toBeNull();
    expect(parseModelRef("")).toBeNull();
    expect(parseModelRef(null)).toBeNull();
    expect(parseModelRef(42)).toBeNull();
  });
});

// --- buildCapturePrompt ------------------------------------

describe("buildCapturePrompt", () => {
  test("asks for a JSON array, lists every memory type, embeds the transcript", () => {
    const p = buildCapturePrompt("user: hello world", 5);
    expect(p).toContain("JSON array");
    expect(p).toContain("at most 5");
    for (const t of [
      "decision",
      "learning",
      "preference",
      "blocker",
      "context",
      "pattern",
    ]) {
      expect(p).toContain(t);
    }
    expect(p).toContain("hello world");
  });

  test("asks for retrieval keywords alongside every candidate", () => {
    const p = buildCapturePrompt("user: hello world", 5);
    expect(p).toContain('"kw": ["...", "..."]');
    expect(p).toContain("3-5 search keywords");
    // The prompt is also where the "indexed, never rendered" contract lives.
    expect(p).toContain("never shown to a model");
  });

  //results.md §29-30: the same lesson scored OUTSIDE the recall window as
  // session diary and ranked 1-7 for the terse symptom queries agents actually
  // issue when it opened with the observable trigger. The rule is the write-
  // side half of retrieval alignment; pin it so a prompt refactor cannot drop
  // it back to diary form.
  test("requires symptom-first content for lessons", () => {
    const p = buildCapturePrompt("user: hello world", 5);
    expect(p).toContain("START the content with the observable trigger");
    expect(p).toContain("When <symptom>: <fact>");
    expect(p).toContain("words of the symptom itself");
  });

  // The line is load-bearing for cost, not precision: dropping it multiplies
  // reasoning and wall clock on the capture fixture. Pin it so a prompt
  // refactor cannot silently remove the bound.
  test("bounds output volume so one fact does not arrive under several scopes", () => {
    const p = buildCapturePrompt("user: hello world", 3);
    expect(p).toContain("Few is better than full");
    expect(p).toContain(
      "Never emit the same fact twice under different scope names",
    );
  });

  test("redacts common secrets without treating ordinary code identifiers as secrets", () => {
    // Fixtures are split so secret scanners (GitHub push protection) skip them.
    const secrets = [
      "sk-" + "proj-AbCdEf0123456789AbCdEf0123456789xyz",
      "sk-" + "ant-api03-AbCdEf0123456789AbCdEf0123456789",
      "gh" + "p_AbCdEf0123456789AbCdEf0123456789AbCd",
      "gh" + "o_AbCdEf0123456789AbCdEf0123456789AbCd",
      "github" + "_pat_11AAAAAA0AbCdEf0123456789AbCdEf0123456789",
      "xo" + "xb-123456789012-123456789012-AbCdEf0123456789",
      "AK" + "IAIOSFODNN7EXAMPLE",
      "AI" + "zaSyD-1234567890abcdefghijklmnopqrstuvwxyz",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
      "DATABASE_PASSWORD=f9Kx2mQ7vN4pL8sR1wZ6",
      "-----BEGIN " +
        "PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
    ];
    const ordinary = [
      "const API_TOKEN = resolveTokenName;",
      "API_KEY=process.env.OPENAI_API_KEY",
      "the Bearer authentication-scheme-description",
    ];
    const p = buildCapturePrompt(
      `user: ${secrets.join("\n")}\n${ordinary.join("\n")}`,
      3,
    );
    for (const secret of secrets) expect(p).not.toContain(secret);
    expect(p).toContain("[redacted]");
    for (const line of ordinary) expect(p).toContain(line);
  });
});
