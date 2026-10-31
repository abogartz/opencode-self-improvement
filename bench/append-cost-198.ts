// Investigation-only paired benchmark: fresh process per mode/size.
// bun bench/append-cost-198.ts <source-root> <MiB> <mode> <round>
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [source, sizeText, mode, round] = Bun.argv.slice(2);
if (!source || !sizeText) throw new Error("source root and MiB required");
const root = mkdtempSync(join(tmpdir(), "osi198-cost-"));
process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
const load = (name: string) => import(pathToFileURL(join(source, "src", name)).href);
try {
  const { appendMemory } = await load("memory.ts");
  const { formatLine, readLines } = await load("logfmt.ts");
  const { dateStr, memoryRoot } = await load("config.ts");
  mkdirSync(memoryRoot(), { recursive: true });
  const file = join(memoryRoot(), `${dateStr()}.logfmt`);
  const row = (i: number) => `${formatLine({ ts: new Date(Date.UTC(2000, 0, 1) + i).toISOString(), type: "learning", scope: "cost", content: "synthetic ".repeat(100), repo: "global" })}\n`;
  const count = Math.ceil(Number(sizeText) * 1024 * 1024 / Buffer.byteLength(row(0)));
  const seed = Array.from({ length: count }, (_, i) => row(i)).join("");
  writeFileSync(file, seed);
  const latencyMs: number[] = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    await appendMemory({ type: "learning", scope: "cost", content: `new row ${i}`, repo: "global" });
    const elapsed = performance.now() - start;
    if (i >= 2) latencyMs.push(elapsed);
  }
  if (!readFileSync(file, "utf8").startsWith(seed)) throw new Error("Existing bytes changed");
  if ((await readLines(file)).length !== count + 12) throw new Error("Row conservation failed");
  console.log(JSON.stringify({ mode, round: Number(round), platform: process.platform, bun: Bun.version,
    sizeMiB: Number(sizeText), seedBytes: Buffer.byteLength(seed), seedRows: count, warmups: 2,
    latencyMs, oldBytesPreserved: true, rowsPreserved: true }));
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
