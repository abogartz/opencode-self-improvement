// Identity of the lock artifact for a store file.
//
// The file protocol used to carry an owner token inside the lock file, and tests
// read it back to prove a refused writer never displaced the holder. A SQLite
// lock has no token — the holder is a kernel record, not a string — so the
// equivalent question is whether the lock ARTIFACT was replaced underneath the
// holder. A recreated database has a different inode. Size is deliberately NOT
// part of the identity: a WAL checkpoint legitimately changes it, and a witness
// that changes during normal, correct operation tells a test nothing.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { lockDatabaseFor } from "../../src/store/lock.ts";

/** `"absent"` when there is no lock database yet. */
export function lockIdentity(file: string): string {
  try {
    return String(statSync(lockDatabaseFor(file)).ino);
  } catch {
    return "absent";
  }
}

/**
 * `name:inode` for the lock database and both write-ahead-log sidecars.
 *
 * A directory listing cannot tell "nothing happened" from "deleted and
 * recreated": the NAMES come back identical either way. The inodes do not, so
 * this is the witness that makes the #407 property observable — the mutation
 * that unlinks `-shm` per acquisition survived a listing comparison and dies on
 * this one.
 */
export function lockArtifacts(file: string): string {
  const db = lockDatabaseFor(file);
  const name = basename(db);
  return ["", "-wal", "-shm"]
    .map((suffix) => {
      try {
        return `${name}${suffix}:${statSync(db + suffix).ino}`;
      } catch {
        return `${name}${suffix}:absent`;
      }
    })
    .join(" ");
}
