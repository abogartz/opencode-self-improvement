// Teardown for a temporary store directory.
//
// The store lock is a SQLite connection (#407), and a connection is an open
// file. Windows refuses to delete a directory that contains one, so a fixture
// that removes its store while this process still holds the connection fails
// with EBUSY — measured on the Windows runner, where it took down most of the
// suite. Under the old lock file there was no handle outliving a write, so this
// is a requirement the new mechanism brings: whoever deletes a store says so
// first.
//
// That is also the answer for a real user. Deleting the memory root while an
// opencode session is alive is a stop-the-session operation on Windows.
import { rmSync } from "node:fs";
import { closeAllLockDatabases } from "../../src/store/lock.ts";

/** Removes `dir`, releasing this process's lock handles first. */
export function removeStore(dir: string): void {
  closeAllLockDatabases();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
