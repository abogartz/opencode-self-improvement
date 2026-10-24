// A spawned test process must never be able to write outside a temporary
// store: a test that can touch real state is a defect regardless of what it
// asserts. Guards, not care. (Inheriting env in a spawned writer once wrote
// 140 rows into the developer's real memory store.)
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, sep } from "node:path";

export function requireTempPath(path: string, role: string): void {
  let p = path;
  while (!existsSync(p)) {
    const up = dirname(p);
    if (up === p) {
      console.error(`${role}: refusing to run against a path that cannot be checked: ${path}`);
      process.exit(2);
    }
    p = up;
  }
  if (!realpathSync(p).startsWith(realpathSync(tmpdir()) + sep)) {
    console.error(`${role}: refusing to run against a non-temporary store path: ${path}`);
    process.exit(2);
  }
}
