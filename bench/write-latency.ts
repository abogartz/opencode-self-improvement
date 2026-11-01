// Write-latency bench: runWriteGate cost vs the number of embedded call forms.
// The shipped resolver shares ONE tree index per write; the "old" column
// re-implements the pre-fix path (a full 8-glob tree scan + serial reads per
// call form, in gate1 AND per scope memory in gate2) so before/after is
// reproducible on any machine. Hermetic: synthetic repo fixture + temp store.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "osi-wbench-"));
const repo = join(root, "repo");
const SRC_N = 300;
const NM_N = 5000;

for (let i = 0; i < SRC_N; i++) {
  const dir = join(repo, "src", `mod${i % 20}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `file${i}.ts`),
    `export function widget${i}(a, b, c) { return a + b + c; }\nexport const helper${i} = ${i};\n`,
  );
}
const nm = join(repo, "node_modules", "pkg", "lib");
mkdirSync(nm, { recursive: true });
for (let i = 0; i < NM_N; i++) writeFileSync(join(nm, `d${i}.ts`), `export function decoy${i}() {}\n`);

process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
const { runWriteGate } = await import( "../src/gate/gate.ts");
const { appendMemory } = await import("../src/store/files/append.ts");

const SCOPE = "wbench";
// Scope memories with embedded call forms: gate2 resolves every one of them.
for (let i = 0; i < 20; i++) {
  const content = i % 4 === 0
    ? `Seeded note ${i}: widgets.widget${i}(a, b, c) returns the sum in src/mod${i % 20}/file${i}.ts`
    : `Seeded note ${i}: plain prose without call forms`;
  await appendMemory({ type: "learning", scope: SCOPE, content });
}

// ---- old model (pre-fix): full enumeration per call form -------------------
const SKIP_DIRS = ["node_modules", ".git", ".hg", ".svn"];
const SOURCE_EXTS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
function relRank(rel: string): number {
  const seg = rel.split("/");
  if (seg.some((s) => SKIP_DIRS.includes(s))) return Infinity;
  if (rel.endsWith(".d.ts")) return Infinity;
  let rank = 0;
  if (seg.includes("src")) rank -= 100;
  if (seg.some((s) => ["dist", "build", "out", "lib"].includes(s))) rank += 50;
  if (/\.(js|mjs|cjs)$/.test(rel)) rank += 10;
  return rank;
}
async function oldScan(liveRoot: string): Promise<string[]> {
  const out = new Set<string>();
  for (const ext of SOURCE_EXTS) {
    try {
      for await (const f of new Bun.Glob(`**/*.${ext}`).scan(liveRoot)) out.add(f);
    } catch {}
  }
  return [...out].filter((f) => relRank(f) < Infinity);
}
async function oldFindLiveCall(name: string, liveRoot: string): Promise<string | null> {
  const files = (await oldScan(liveRoot)).sort();
  for (const rel of files) {
    let text: string;
    try {
      text = await Bun.file(join(liveRoot, rel)).text();
    } catch {
      continue;
    }
    if (text.includes(name)) return rel;
  }
  return null;
}

function timed(label: string, ms: number) {
  console.log(`${label.padEnd(42)} ${ms.toFixed(0)}ms`);
}

// Old-model cost for a write with k candidate forms: every form (candidate +
// scope memories with forms) pays one full scan, serially.
const scopeForms = 5; // seeded above: every 4th of 20 notes embeds a form
for (const k of [1, 3, 5]) {
  const forms = Array.from({ length: k }, (_, i) => `widgets.widget${i}(a, b, c)`).join(" and ");
  const candidate = {
    type: "learning",
    scope: SCOPE,
    content: `Probe ${k} ${Date.now()}: ${forms} verified in src/mod0/file0.ts.`,
  };
  const t0 = performance.now();
  await runWriteGate(candidate as never, { liveRoot: repo, evidenceCalls: [], hasGateCheck: true } as never);
  timed(`shipped — ${k} call form(s)`, performance.now() - t0);

  const t1 = performance.now();
  for (let i = 0; i < k + scopeForms; i++) await oldFindLiveCall(`widget${i % SRC_N}`, repo);
  timed(`old model — ${k + scopeForms} scans + reads`, performance.now() - t1);
}
