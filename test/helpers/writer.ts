// A second writer process for the cross-process store stress tests: a stand-in
// for another opencode session (or the viewer) sharing one memory root. Runs
// appends and whole-file rewrites concurrently, exactly as two live sessions
// would, and reports what it believes it wrote.
import { appendMemory } from "../../src/store/files/append.ts"
import { markSuperseded } from "../../src/store/files/supersede.ts";
import { requireTempPath } from "./temp-root.ts";

const [dir, countRaw, supersededRaw] = process.argv.slice(2);
if (!dir) {
  console.error("usage: writer.ts <memory-dir> <appends> <ts,ts,...>");
  process.exit(2);
}
requireTempPath(dir, "writer");
process.env.OPENCODE_MEMORY_DIR = dir;

const appends = Number(countRaw ?? 0);
const supersede = (supersededRaw ?? "").split(",").filter(Boolean);

await Promise.all([
  ...Array.from({ length: appends }, (_, i) =>
    appendMemory({ type: "learning", scope: "stress", content: `child row ${i} ${process.pid}` }),
  ),
  ...supersede.map((ts) => markSuperseded(ts, { superseded_by: "stress", reason: "stress" })),
]);

console.log(JSON.stringify({ pid: process.pid, appends, superseded: supersede.length }));
