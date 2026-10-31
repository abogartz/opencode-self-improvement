// Exercise the real write entry points in a separate process, with only the
// wait budget shortened. The production timeout policy remains untouched.
import { appendMemory, clearSuperseded, markManySuperseded, markSuperseded, prune } from "../../src/memory.ts";
import { addBlock, removeBlock } from "../../src/blocklist.ts";
import { deleteMemory, unrejectMemory } from "../../src/viewer/mutate.ts";
import { tombstoneMany } from "../../src/tombstones.ts";
import { contentHash } from "../../src/evidence.ts";
import { LOCK_WRITE } from "../../src/lock.ts";
import { requireTempPath } from "./temp-root.ts";

const [root, operation, ts] = process.argv.slice(2);
if (!root || !operation || !ts) throw new Error("usage: lock-timeout-writer.ts <root> <operation> <ts>");
requireTempPath(root, "lock-timeout-writer");
process.env.OPENCODE_MEMORY_DIR = root;
LOCK_WRITE.timeoutMs = 40;
const fields = { superseded_by: "replacement", reason: "timeout regression" };
try {
  switch (operation) {
    case "append":
      await appendMemory({ type: "learning", scope: "timeout", content: "the child row must survive an acknowledged append", repo: "global" });
      break;
    case "prune": await prune("timeout", "learning", "timeout regression"); break;
    case "supersede": await markSuperseded(ts, fields); break;
    case "batch": await markManySuperseded([{ ts, fields }]); break;
    case "clear": await clearSuperseded(ts); break;
    case "delete": await deleteMemory({ ts, reason: "timeout regression" }); break;
    case "block": await addBlock(ts, "timeout regression"); break;
    case "unblock": await removeBlock(ts); break;
    case "tombstone": await tombstoneMany([{ content: "newly rejected value" }], { reason: "timeout regression", source: "test" }); break;
    case "unreject": await unrejectMemory(contentHash("existing value rejected by human")); break;
    default: throw new Error(`unknown operation: ${operation}`);
  }
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }));
}
