// Contract: capture and identity triggers must be declared AND recorded from
// a live host. Other event reads below have a weaker declaration/legacy check.
//
// Why this file exists (#136): auto-capture waited for `session.idle`, and the
// feature was dead on every 2.x host with no warning anywhere. The manifest DOES
// declare `session.idle` — so schema membership alone would have passed, and the
// tests fabricated the same envelope anyway (fake and prod wrong together, the
// lesson already paid for in #86 and #90). What caught the bug was a recording of
// the live host: `session.idle` and `session.status` are declared but never
// emitted, while `session.execution.succeeded` is emitted on every turn end.
//
// So the authority here is the RECORDING, and the manifest is only the weaker
// necessary condition. Both are asserted.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionEvent } from "@opencode/schema/session-event";
import { Schema } from "effect";
import { CAPTURE_EVENT_TYPES } from "../src/index.ts";
import { IDENTITY_EVENT_TYPES } from "../src/host.ts";
import moveRecording from "./fixtures/host-session-move.json";

const MANIFEST = join(import.meta.dir, "../node_modules/@opencode/schema/dist/event-manifest.d.ts");
const RECORDING = join(import.meta.dir, "fixtures/host-events.jsonl");
const SRC = join(import.meta.dir, "../src");

// Recorded from a running desktop service (opencode-cli 2.1.4, `GET /api/event`
// SSE): two complete turns plus 80 s of quiet afterwards. Event NAMES and counts
// only — no payload, no prompt content.
const observed = new Map<string, number>(
  readFileSync(RECORDING, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; count: number })
    .map((r) => [r.type, r.count]),
);

// The separate 2.2.2 recording exercises a move, which the original two-turn
// recording did not. Keep their counts/provenance separate; absence from one
// workload alone does not establish that a declared event is never emitted.
const identityObserved = new Set([...observed.keys(), ...moveRecording.events.map((e) => e.type)]);

// Names absent from the original recording, not proof that they are dead.
const declaredButUnobserved = (declared: Set<string>) =>
  [...declared].filter((t) => t.startsWith("session.") && !observed.has(t));

// Event names the plugin reads from OLDER hosts. Each entry is a deliberate
// compatibility read, not a guess; the list is short so drift is visible.
const LEGACY_HOST_EVENTS = new Set(["message.updated"]);

const declaredSet = new Set<string>(
  [...readFileSync(MANIFEST, "utf8").matchAll(/\btype:\s*"([a-z][a-z0-9_.]*)"/g)].map((m) => m[1]),
);

describe("host event fidelity (#136, #137, #176)", () => {
  // Controls first: a parser that matched nothing would make every assertion
  // below vacuously true, and a harness that cannot fail does not count.
  test("both sources were actually parsed", () => {
    expect(declaredSet.size).toBeGreaterThan(50);
    expect(observed.size).toBeGreaterThan(10);
    expect(observed.has("session.execution.succeeded")).toBe(true);
    expect(moveRecording.events.map((e) => e.type)).toContain("session.moved");
    // Deliberately pins the original two-turn workload. A future capture that
    // includes moves belongs in a separately identified recording; do not
    // silently rewrite this historical absence or broaden its conclusion.
    expect(observed.has("session.moved")).toBe(false);
  });

  test("the move extract declares its recording provenance", () => {
    // Required metadata is a review aid, not authentication of a live capture.
    for (const field of [moveRecording.provenance.host, moveRecording.provenance.recordedAt]) {
      expect(typeof field).toBe("string");
      expect(field.trim().length).toBeGreaterThan(0);
    }
    expect(Array.isArray(moveRecording.provenance.procedure)).toBe(true);
    expect(moveRecording.provenance.procedure.length).toBeGreaterThan(0);
    for (const step of moveRecording.provenance.procedure) {
      expect(typeof step).toBe("string");
      expect(step.trim().length).toBeGreaterThan(0);
    }
  });

  test("every retained envelope round-trips through the pinned host schema", () => {
    expect(moveRecording.events.length).toBeGreaterThan(0);
    for (const event of moveRecording.events) {
      const decoded = Schema.decodeUnknownSync(SessionEvent.All, { onExcessProperty: "error" })(event);
      const encoded: unknown = Schema.encodeSync(SessionEvent.All)(decoded);
      expect(encoded).toEqual(event);
    }
  });

  test("every event type auto-capture reacts to is declared by the protocol", () => {
    expect(CAPTURE_EVENT_TYPES.filter((t) => !declaredSet.has(t))).toEqual([]);
  });

  // The assertion that would have caught #136 two releases ago.
  test("every event type auto-capture reacts to was really observed on a live host", () => {
    const neverSent = CAPTURE_EVENT_TYPES.filter((t) => !observed.has(t));
    expect(neverSent).toEqual([]);
  });

  test("every identity trigger is declared by the protocol", () => {
    expect(IDENTITY_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(IDENTITY_EVENT_TYPES.filter((t) => !declaredSet.has(t))).toEqual([]);
  });

  test("every identity trigger was observed in a live-host recording", () => {
    expect(IDENTITY_EVENT_TYPES.filter((t) => !identityObserved.has(t))).toEqual([]);
  });

  test("`session.idle` is declared but absent from the recorded turns and capture triggers", () => {
    expect(declaredSet.has("session.idle")).toBe(true); // it exists on paper…
    expect(observed.has("session.idle")).toBe(false); // …but the recorded turns did not emit it
    expect(CAPTURE_EVENT_TYPES.includes("session.idle")).toBe(false);
    expect(declaredButUnobserved(declaredSet).length).toBeGreaterThan(0); // the category is real
  });

  test("inline event-name reads are declared or explicitly legacy", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
      readFileSync(join(SRC, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          // Only lines reading an event envelope's `type`, so memory row types
          // ("decision", "learning") and prose stay out of scope.
          if (!/\b(?:ev|event)\??\.type\b/.test(line)) return;
          for (const m of line.matchAll(/"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"/g)) {
            const name = m[1];
            if (declaredSet.has(name) || LEGACY_HOST_EVENTS.has(name)) continue;
            offenders.push(`${file}:${i + 1} → ${name}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
