// Second process that HOLDS the store lock until the parent stops it, so a test
// can watch what a live cross-process holder does to another writer.
//
// It holds through the real path (withStoreLock + LOCK_WRITE), not by writing a
// file that merely looks like a lock: the point of these tests is the kernel
// lock, and a fixture that fakes the artifact proves nothing about it.
//
// The parent drives the release with a signal:
//   SIGTERM  -> the section returns and the lock is given back cleanly.
//   SIGKILL  -> the process dies INSIDE the section. SQLite's lock goes with it
//               and the write-ahead log is left for the next opener to
//               recover, which is the crash case the lock has to survive.
import { appendLog } from "../../src/core/logfmt/publish.ts";
import { LOCK_WRITE, withStoreLock } from "../../src/store/lock.ts";
import { requireTempPath } from "./temp-root.ts";

const file = process.argv[2];
const line = process.argv[3];
if (!file) {
  console.error("usage: lock-holder-held.ts <store-file> [line-to-append]");
  process.exit(2);
}
requireTempPath(file, "lock-holder-held");

let stop!: () => void;
const stopped = new Promise<void>((res) => (stop = res));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => stop());
}

await withStoreLock(
  file,
  async () => {
    if (line) await appendLog(file, line);
    // Flush before waiting: a parent that never sees this line would wait for a
    // holder that had not reached the lock yet.
    process.stdout.write("held\n");
    await stopped;
  },
  LOCK_WRITE,
);
