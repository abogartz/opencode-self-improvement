// The temp-path guard has to agree with the OS about what "inside the temp
// dir" means. It shipped comparing against realpathSync(tmpdir()) + "/":
// on Windows realpath yields BACKSLASH paths, so no temp path ever matched
// and every guarded child exited 2 against its own perfectly temporary
// store. Both directions are pinned here — passing and refusing.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { requireTempPath } from "./helpers/temp-root.ts";

describe("requireTempPath", () => {
  test("accepts a path under the system temp dir, whatever the separator", () => {
    const root = mkdtempSync(join(tmpdir(), "osi-guard-"));
    try {
      // A rejected path calls process.exit(2) — if the comparison is wrong
      // for this platform, this line ends the whole test process.
      requireTempPath(join(root, "memory"), "probe");
      expect(true).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test("a guarded child refuses a non-temporary store path before touching it", () => {
    const writer = join(import.meta.dir, "helpers", "writer.ts");
    // homedir, not the repo: checkouts can themselves sit under the temp dir
    // (they do on the reference machine), which would make a repo path a
    // legitimate temp path and the refusal vacuous.
    const p = Bun.spawnSync([process.execPath, writer, homedir(), "1"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toMatch(/non-temporary/);
  });
});
