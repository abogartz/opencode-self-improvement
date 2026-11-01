// Second process for the lock contract tests: takes the store lock the same way
// the plugin does, then appends one line, so a lock that another process
// ignores shows up as an out-of-order line.
import { appendLog } from "../../src/core/logfmt/publish.ts";
import { withStoreLock } from "../../src/store/lock.ts";
import { requireTempPath } from "./temp-root.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: lock-holder.ts <store-file>");
  process.exit(2);
}
requireTempPath(file, "lock-holder");
await withStoreLock(file, () => appendLog(file, "ts=child writer=child"));
