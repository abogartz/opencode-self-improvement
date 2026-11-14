// Parent side of the cross-process lock holder.
//
// These tests need a rival that really holds the store lock from another
// process. Writing a file that looks like a lock was possible under the old
// protocol and proves nothing under this one: the lock is a kernel byte-range
// record on a SQLite database, so the only honest contention fixture is a live
// second process that took it the same way production does.
import { join } from "node:path";

export interface CrossProcessHolder {
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  /** Ask the holder to finish its section and exit, and wait for it. */
  release(): Promise<{ code: number | null; err: string }>;
  /** Kill -9 inside the section: the lock must go with the process. */
  crash(): void;
}

/** Resolves once the child reports it holds the lock. */
export async function childHolder(
  file: string,
  appendLine?: string,
): Promise<CrossProcessHolder> {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "lock-holder-held.ts"),
      file,
      ...(appendLine ? [appendLine] : []),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("held")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  if (!seen.includes("held")) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`child never reached the lock: ${err.trim()}`);
  }
  return {
    proc,
    async release() {
      proc.kill();
      const code = await proc.exited;
      const err = await new Response(proc.stderr).text();
      return { code, err: err.trim() };
    },
    crash() {
      proc.kill(9);
    },
  };
}
