// Deterministic injection-cost bench.
//
// Answers "what does memory injection actually cost?" with reproducible
// numbers from THIS plugin's real injection code (src/inject.ts), not
// estimates.
//
//   Policy A (naive):   recompute relevantKnowledge on every prompt, uncapped.
//   Policy B (pre-#162): the block is frozen against the STORE FINGERPRINT, but
//                       the standing digest is rebuilt every request and carries
//                       the row count + latest ts. So the bytes that actually
//                       rode the system prompt changed after every write, even
//                       when the block did not — the arm whose cache claim was
//                       false. Measuring only the block is how that survived.
//   Policy C (pre-#165): the whole memory section (digest + frontier + block) is
//                       frozen and the RENDERED BYTES decide whether it moved.
//   Policy D (shipped): C plus the riding-bytes rule — the three mid-session
//                       writes are made BY the measured session, so re-rendering
//                       the section without them reproduces the frozen bytes and
//                       nothing moves. A removal, a rewrite of a riding row, or
//                       another session's row survives that subtraction and still
//                       busts; test/epoch.test.ts pins those.
//
// Everything below is measured on the FULL memory section, the bytes a request
// actually sends, because prompt caching is a property of those bytes.
//
// Determinism: a fixed-seed LCG generates the store and
// the prompts; memory timestamps are synthetic (no Date.now()); nothing reads
// Math.random; RESULTS.md carries no wall-clock stamp — `bun bench/inject-cost.ts`
// is byte-identical across runs.
//
// Run: bun bench/inject-cost.ts   (also: bun run bench)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic store: a temp dir, never the real one. config.ts
// reads OPENCODE_MEMORY_DIR lazily inside every helper call, so
// setting it here — before the first store read below — is sufficient even
// though the imports below are hoisted.
const tmp = mkdtempSync(join(tmpdir(), "osi-bench-"));
const store = join(tmp, "memory");
process.env.OPENCODE_MEMORY_DIR = store;
delete process.env.OPENCODE_MEMORY_INJECT_BUDGET; // the bench measures the DEFAULT budget

import { injectBudget } from "../src/core/config/budgets.ts";
import { compactionAnchor } from "../src/inject/anchor.ts"
import { capToBudget } from "../src/inject/budget.ts"
import { systemDigest } from "../src/inject/digest.ts"
import { storeVersion } from "../src/inject/version.ts"
import { relevantKnowledge } from "../src/recall/relevant.ts";
import { loadAll } from "../src/store/files/load.ts"
import { type Memory } from "../src/store/model/memory.ts"
import { isActive } from "../src/store/model/predicates.ts";
import { formatLine } from "../src/core/logfmt/format.ts";

// --- deterministic generator -----------------------------------------------------

// Classic LCG (numerical recipes parameters). Not Math.random: the whole point
// is that every run produces the same store, the same prompts, the same table.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rand = lcg(20261018);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

const TOPICS = ["vitest", "bun", "esbuild", "playwright", "docker", "postgres", "redis", "nginx", "graphql", "rust"] as const;
const SCOPES = ["build", "api", "auth", "infra", "db", "frontend", "cli", "docs"] as const;
const TYPES = ["learning", "pattern", "decision", "preference", "blocker", "context"] as const;
const PHRASES = [
  "run the suite from the repository root, never a subdirectory",
  "the cache key must include the schema version or reads go stale",
  "flaky retries are capped at two before the job is marked failed",
  "the migration lock is held for the whole transaction window",
  "port collisions in ci are resolved by binding an ephemeral port",
  "the build output is cached between runs keyed by the lockfile hash",
  "timeouts are configured per environment and overridable by env var",
  "the rate limiter counts requests per key per rolling minute",
  "snapshot files are written before every destructive mutation",
  "the config loader merges the project file over the global default",
  "schema changes require regenerating the typed client afterwards",
  "the deploy gate blocks until lint and typecheck both pass clean",
  "log lines are logfmt so structured fields stay machine readable",
  "the index rebuild is incremental unless a refactor forces full mode",
  "secrets are read from the agent environment, never the repository",
  "the retry budget is exhausted before the circuit breaker opens",
  "fixtures are seeded once per suite and reset between test files",
  "the proxy strips internal headers before forwarding upstream calls",
  "bundle size is asserted in ci with a per-package character budget",
  "the queue consumer acknowledges only after the write is durable",
  "feature flags are evaluated server side and cached per request",
  "the backup job verifies checksums before it prunes old snapshots",
  "watch mode debounces file events by fifty milliseconds to coalesce",
  "the auth middleware refreshes tokens only on a forty-one response",
] as const;
const PROMPT_WORDS = ["run", "build", "test", "cache", "config", "deploy", "check", "rate", "limit", "rebuild"] as const;

interface Row {
  ts: string;
  type: string;
  scope: string;
  content: string;
  status: string;
}

// Synthetic base timestamp: memory rows never use the wall clock.
const BASE = Date.parse("2026-09-01T00:00:00.000Z");
const iso = (offsetSec: number) => new Date(BASE + offsetSec * 1000).toISOString();

// 50 memories: topic+scope prefix (so prompts can match them) plus enough
// phrases to land between ~260 and ~560 chars — realistic durable-memory size.
const memories: Row[] = [];
for (let i = 0; i < 50; i++) {
  const topic = TOPICS[i % TOPICS.length];
  const scope = pick(SCOPES);
  const type = pick(TYPES);
  const target = 260 + Math.floor(rand() * 300);
  let content = `${topic} ${scope}:`;
  while (content.length < target) content += ` ${pick(PHRASES)}`;
  memories.push({ ts: iso(i * 37), type, scope, content, status: i % 7 === 3 ? "open" : "settled" });
}

// 20 user prompts: one topic each plus a couple of shared vocabulary words.
const prompts: string[] = [];
for (let i = 0; i < 20; i++) {
  prompts.push(`${TOPICS[i % TOPICS.length]} ${pick(PROMPT_WORDS)} ${pick(PROMPT_WORDS)} how`);
}

// Three writes that land mid-session (turns 5, 10, 15). They change the store
// fingerprint; whether each one changes what the session is SHOWN is exactly
// what the bust columns measure — do not assume all three are visible.
const SESSION_WRITES: Array<{ scope: string; content: string }> = [
  { scope: "infra", content: "Mid-session fact one: the staging deploy waits for the health check to pass twice in a row." },
  { scope: "ledger", content: "Mid-session fact two: nimrod flurb quux calibration prunes stale zebra-dashboard widget ledgers nightly." },
  { scope: "cli", content: "Mid-session fact three: the import tool tags every promoted row so provenance survives a round trip." },
];

const storeFile = () => join(store, "2026-09-01.logfmt");

function seedStore(): void {
  rmSync(store, { recursive: true, force: true });
  mkdirSync(store, { recursive: true });
  const lines = memories.map((m) =>
    formatLine({ ts: m.ts, type: m.type, scope: m.scope, content: m.content, status: m.status }),
  );
  writeFileSync(storeFile(), lines.join("\n") + "\n");
}

// --- policy runs (mirror the real hooks in src/index.ts) ---------------------------

const budget = injectBudget(); // 1200 (env cleared above)

// The standing digest + open-thread frontier, exactly as the context hook
// renders it from the CURRENT store (or from the rows a caller supplies — the
// #165 arm re-renders with the session's own additions taken back out).
async function digestParts(sid: string, legacy = false, rows?: Memory[]): Promise<string[]> {
  const all = rows ?? (await loadAll()).filter(isActive);
  const parts: string[] = [];
  await systemDigest({ sessionID: sid }, { system: parts }, { rows: all });
  // Arm B needs the PRE-#162 digest, which src no longer emits: the row count
  // and the latest ts rode at the very front of the system prompt, so every
  // promoted write rewrote the cached prefix whether or not the model was shown
  // anything new. Reproduced verbatim from the shipped 0.14.x text.
  if (legacy && parts.length && parts[0].startsWith("\n## Persistent memory")) {
    const latest = all.map((m) => m.ts).sort().pop() ?? "?";
    parts[0] =
      "\n## Persistent memory (opencode-self-improvement)\n" +
      `${all.length} durable memories; latest: ${latest}. ` +
      "Check memory_recall BEFORE grepping or reading, for build/test/lint commands, " +
      "decisions, and conventions. Relevant memories are also auto-injected when your " +
      "message matches.";
  }
  return parts;
}
const section = async (sid: string, block: string, legacy = false, rows?: Memory[]) =>
  [...(await digestParts(sid, legacy, rows)), block].join("\n");

// The three writes land mid-session, at turns 5, 10 and 15.
const writeAt = (i: number) => (i === 4 ? 0 : i === 9 ? 1 : i === 14 ? 2 : -1);
function applyWrite(write: number): void {
  appendFileSync(
    storeFile(),
    formatLine({
      ts: iso(2000 + write * 60),
      type: "learning",
      scope: SESSION_WRITES[write].scope,
      content: SESSION_WRITES[write].content,
      status: "settled",
    }) + "\n",
  );
}

// Policy A: the naive behavior — fresh digest plus a re-scored, uncapped block
// on EVERY prompt, which changed the system prefix every turn.
seedStore();
const aSections: string[] = [];
for (const p of prompts) aSections.push(await section("ses-a", await relevantKnowledge(p, 3)));

// Policy B: the pre-#162 shipped behavior — block frozen against the store
// fingerprint and capped at the budget, but the digest rebuilt per request.
seedStore();
const bSections: string[] = [];
let bEpoch: { version: string; block: string } | null = null;
let bRecomputes = 0;
for (let i = 0; i < prompts.length; i++) {
  const w = writeAt(i);
  if (w >= 0) applyWrite(w);
  const version = await storeVersion();
  if (!bEpoch || bEpoch.version !== version) {
    const raw = await relevantKnowledge(prompts[i], 5);
    bEpoch = { version, block: raw ? capToBudget(raw, budget) : "" };
    bRecomputes++;
  }
  bSections.push(await section("ses-b", bEpoch.block, true));
}

// Policy C: the shipped behavior — the whole section is rendered, then adopted
// only when its BYTES differ. A write the model cannot see keeps the frozen
// bytes and costs nothing.
seedStore();
const cSections: string[] = [];
let cEpoch: { version: string; section: string } | null = null;
let cRecomputes = 0;
for (let i = 0; i < prompts.length; i++) {
  const w = writeAt(i);
  if (w >= 0) applyWrite(w);
  const version = await storeVersion();
  if (!cEpoch || cEpoch.version !== version) {
    const raw = await relevantKnowledge(prompts[i], 5);
    const rendered = await section("ses-c", raw ? capToBudget(raw, budget) : "");
    if (!cEpoch || cEpoch.section !== rendered) {
      cEpoch = { version, section: rendered };
      cRecomputes++;
    } else {
      cEpoch = { version, section: cEpoch.section }; // content-neutral: adopt the version, not the bytes
    }
  }
  cSections.push(cEpoch.section);
}

// Policy D: the shipped behavior plus the riding-bytes rule (#165). The three
// mid-session writes are made BY this session, so each is a fact the model
// already has in its transcript. The section is re-rendered with everything the
// session authored since the frozen bytes taken back out; when that comes back
// identical, the whole difference is the session's own additions and the frozen
// bytes keep riding. A removal or rewrite of a riding row, or another session's
// row, still survives that subtraction and would still bust.
seedStore();
const dSections: string[] = [];
let dEpoch: { version: string; section: string; ownRows: Set<string>; prompt: string } | null = null;
let dRecomputes = 0;
const authored = new Set<string>();
for (let i = 0; i < prompts.length; i++) {
  const w = writeAt(i);
  if (w >= 0) {
    applyWrite(w);
    authored.add(iso(2000 + w * 60)); // this session wrote it
  }
  const version = await storeVersion();
  if (!dEpoch || dEpoch.version !== version) {
    const rows = (await loadAll()).filter(isActive);
    const raw = await relevantKnowledge(prompts[i], 5, rows);
    const rendered = await section("ses-d", raw ? capToBudget(raw, budget) : "", false, rows);
    let adopt = !dEpoch || dEpoch.section !== rendered;
    if (adopt && dEpoch) {
      const frozen = dEpoch;
      const extra = rows.filter((m) => authored.has(m.ts) && !frozen.ownRows.has(m.ts));
      if (extra.length) {
        // Re-score the SAME inputs the frozen bytes came from — same rows minus
        // the session's own additions, same prompt. A topic change is not a
        // content change: the epoch refuses to refresh for one anyway.
        const back = rows.filter((m) => !extra.some((e) => e.ts === m.ts));
        const rawBack = await relevantKnowledge(frozen.prompt, 5, back);
        if ((await section("ses-d", rawBack ? capToBudget(rawBack, budget) : "", false, back)) === frozen.section) {
          adopt = false;
        }
      }
    }
    if (adopt) {
      dEpoch = {
        version,
        section: rendered,
        prompt: prompts[i],
        ownRows: new Set(rows.filter((m) => authored.has(m.ts)).map((m) => m.ts)),
      };
      dRecomputes++;
    } else if (dEpoch) {
      // Content-neutral store change: adopt the fingerprint, keep the frozen bytes.
      dEpoch.version = version;
    }
  }
  // The first turn always adopts (there is nothing frozen yet), so the epoch is
  // never empty here; stated as a check rather than an assertion.
  if (!dEpoch) throw new Error("bench: epoch not initialised");
  dSections.push(dEpoch.section);
}

// The compaction anchor: pushed once per compaction, capped at 2500.
seedStore();
const anchor = await compactionAnchor();

// --- report --------------------------------------------------------------------------

const sum = (xs: string[]) => xs.reduce((a, b) => a + b.length, 0);
const worst = (xs: string[]) => Math.max(0, ...xs.map((b) => b.length));
// What the provider cache actually sees: how many times the riding bytes changed
// after the first fill. One change = one full re-prefill of the conversation.
const busts = (xs: string[]) => xs.reduce((n, s, i) => (i > 0 && s !== xs[i - 1] ? n + 1 : n), 0);
const sumA = sum(aSections);
const sumB = sum(bSections);
const sumC = sum(cSections);
const sumD = sum(dSections);
const saved = sumA > 0 ? ((sumA - sumD) / sumA) * 100 : 0;
const f1 = (n: number) => n.toFixed(1);

const report = `# Injection cost — measured

Reproduce with \`bun bench/inject-cost.ts\` (deterministic: fixed-seed LCG,
synthetic timestamps, no wall clock in the output — reruns are byte-identical).
The numbers come from the plugin's real injection code (\`src/inject.ts\`):
a seeded store of ${memories.length} memories, a simulated session of
${prompts.length} user prompts with 3 mid-session store writes, and the default
${budget}-character budget. Every column is measured on the FULL memory section
(digest + frontier + relevance block) — the bytes a request actually sends,
because prompt caching is a property of those bytes and not of the block alone.

| Policy | Recomputes | Cache busts | Injected chars (${prompts.length} turns) | Avg/turn | Worst section |
| --- | ---: | ---: | ---: | ---: | ---: |
| A — recompute per prompt, uncapped (naive) | ${aSections.length} | ${busts(aSections)} | ${sumA} | ${f1(sumA / aSections.length)} | ${worst(aSections)} |
| B — block frozen on store fingerprint, digest rebuilt per turn (pre-#162) | ${bRecomputes} | ${busts(bSections)} | ${sumB} | ${f1(sumB / bSections.length)} | ${worst(bSections)} |
| C — section frozen on rendered bytes (pre-#165) | ${cRecomputes} | ${busts(cSections)} | ${sumC} | ${f1(sumC / cSections.length)} | ${worst(cSections)} |
| D — C + riding bytes: the session's own additions are free (shipped) | ${dRecomputes} | ${busts(dSections)} | ${sumD} | ${f1(sumD / dSections.length)} | ${worst(dSections)} |

A "cache bust" is a turn whose memory-section bytes differ from the turn
before: each one re-bills the whole conversation as fresh input.

The three mid-session writes are made BY the session being measured, which is
how memory actually gets written — the model saves what it just learned. All
three turn out to change what that session is shown (a new row shifts the
document frequencies and reorders the top-5), so B and C each pay ${busts(bSections)}
busts for them. D pays ${busts(dSections)}: a fact the session produced itself is
already in its transcript. What D still pays for is a riding row being corrected,
blocklisted or redacted, or another session writing a row — those survive the
subtraction and still land on the next request, pinned by \`test/epoch.test.ts\`.

D injects ${f1(saved)}% fewer characters than the naive policy.

Compaction anchor (capped at 2500 chars): ${anchor.length} chars,
pushed once per compaction rather than per turn.
`;

writeFileSync(join(import.meta.dir, "RESULTS.md"), report);
console.log(report);

rmSync(tmp, { recursive: true, force: true });
delete process.env.OPENCODE_MEMORY_DIR;
