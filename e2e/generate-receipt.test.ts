// #395: the host limitation, pinned in CI.
//
// Capture's cost is an estimate (chars/4, labelled `receipt=none` in PR #394,
// which is still OPEN and not on main) because `ctx.generate.text` resolves to
// `{ text }` with no provider receipt. That claim was probed by hand on
// 2026-11-11; this test makes it machine-checked. The fake model attaches
// `usage` to every final chunk — a real openai-compatible provider reports the
// same — so what the probe plugin sees is the host's contract, not the
// provider's silence.
//
// That premise is checked from BOTH ends, because a test that only reads the
// plugin's own file stays green after the provider stops reporting: the probe's
// generate call must appear in the fake model's request log, and the final
// chunk served back to it must carry `usage` — recorded from the object that
// was actually written, see finalChunk() in ./support/fake-model.ts.
//
// This is a CHARACTERIZATION test: it pins today's shape, it does not endorse
// it. When upstream surfaces usage on the generate result (#395 route 1), the
// `usage` assertion below fails, and that failure is the trigger to flip this
// test and — once #394 lands, which is where `capture_cost` lives — switch it
// from `receipt=none` to a named source. Until then the estimate stays
// labelled as an estimate: the ticket's explicit non-goal is that a chars/4
// number never becomes a receipt by looking like one.
//
// Route 2 (`session.create` + `prompt` + `wait`) is deliberately not taken,
// and the reason is cost, not a block. Re-probed 2026-11-12 with a 20 s
// timeout on every await: the full route resolved in 37-80 ms on opencode
// v2.2.5 and 39-62 ms on the CI pin v2.0.26, and the route-2 session's
// assistant message carried the provider's numbers in the guest db
// (`{"input":111,"output":22,"reasoning":0,"cache":{"read":0,"write":0}}`).
// So the numbers ARE reachable that way. It is declined because capture stops
// being a fire-and-forget text call and becomes a session — agent, system
// prompt, the full tool list on the wire (26 tools, against the bare generate
// call's none), lifecycle — which changes what capture writes and so
// invalidates the transport benchmark (AC 3). Taking that is a decision for a
// quiet seat with the transport arm ready, not a drive-by on a degraded one
// (F19).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  REPO,
  type Fake,
  type Guest,
  loadFailure,
  makeGuest,
  startFake,
  turn,
} from "./support/harness.ts";

const PROBE = join(import.meta.dir, "support", "probe-plugin");

/** Must match PROBE_PROMPT in ./support/probe-plugin/index.ts. */
const PROBE_PROMPT = "probe receipt";

/** What the fake model attaches to every final chunk. */
const PROVIDER_USAGE = {
  prompt_tokens: 111,
  completion_tokens: 22,
  total_tokens: 133,
};

let fake: Fake;
const guests: Guest[] = [];

beforeAll(async () => {
  fake = await startFake();
});
afterAll(() => {
  fake.stop();
  for (const g of guests.splice(0))
    rmSync(g.root, { recursive: true, force: true });
});

test("generate.text hands the plugin { text } and no usage, even though the provider reported usage", async () => {
  const g = makeGuest(fake, REPO, [PROBE]);
  guests.push(g);
  const probeOut = join(g.root, "probe.json");
  g.env.PROBE_OUT = probeOut;
  fake.setSteps({ "RECEIPT-TURN": [{ content: "done" }] });
  const run = await turn(fake, g, "RECEIPT-TURN", 120_000);
  expect(loadFailure(run)).toBeUndefined();
  // The hook awaits generate.text before the turn completes, so the file is
  // written by now; the short poll only absorbs filesystem flush.
  const deadline = Date.now() + 5_000;
  while (!existsSync(probeOut) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  expect(existsSync(probeOut)).toBe(true);
  const probe = JSON.parse(readFileSync(probeOut, "utf8"));
  expect(probe.error).toBeUndefined();

  // --- the premise: the probe's call reached the provider, and the provider
  // answered it with a receipt. Without these two, the assertions below would
  // pin a provider that never reported anything at all.
  const reached = (await fake.requests()).filter((r) =>
    JSON.stringify(r.messages ?? "").includes(PROBE_PROMPT),
  );
  expect(
    reached.length,
    `the probe's ctx.generate.text call never reached the fake model — no request carries "${PROBE_PROMPT}", so there is no receipt to be lost and this test pins nothing`,
  ).toBeGreaterThan(0);
  const served = (await fake.served()).filter((s) =>
    s.prompt.includes(PROBE_PROMPT),
  );
  expect(
    served.length,
    `the fake model logged no response to the probe's generate call ("${PROBE_PROMPT}") — the provider side of this premise is unobserved`,
  ).toBeGreaterThan(0);
  expect(
    served[served.length - 1]?.chunk.usage,
    "the fake model no longer attaches usage to the final chunk (see finalChunk() in ./support/fake-model.ts) — restore it, or this test is pinning provider silence rather than the host's contract",
  ).toEqual(PROVIDER_USAGE);
  expect(served[served.length - 1]?.chunk.choices?.[0]?.finish_reason).toBe(
    "stop",
  );

  // --- the contract. Three assertions, three messages, checked flip-first so
  // a red always names the right thing: `usage` is the #395 flip trigger,
  // `resultKeys` says what to do for either kind of new member, and
  // `generateKeys` is what the host EXPOSES — a new member there is not the
  // usage flip and must not be read as one.
  expect(
    probe.usage,
    "#395 FLIP TRIGGER: upstream surfaced usage on the generate result — flip this test and name the source capture_cost reads (once #394 lands)",
  ).toBeNull();
  expect(
    probe.resultKeys,
    "the generate result gained a member. If it is `usage`, that is the #395 flip trigger above: flip this test and name the source capture_cost reads (once #394 lands). Any other member: extend this list and leave #395 open.",
  ).toEqual(["text"]);
  expect(
    probe.generateKeys,
    "ctx.generate gained a member; that alone is NOT the #395 usage flip — read the usage assertion before changing this test",
  ).toEqual(["text"]);
  expect(probe.textType).toBe("string");
});
