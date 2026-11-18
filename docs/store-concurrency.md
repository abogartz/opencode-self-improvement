# Store concurrency, publication and permissions

Replacing a store file while other sessions are reading it is the whole
problem. The answer is a book swap, not a page rewrite: the writer builds the
complete new file, then swaps it in under a lock. A reader therefore sees the
old file or the new one, never a half-written record.

How a store file is replaced, what the lock covers, and what the plugin
does and does not do about permissions. The README states the user-visible
rules and links here.

Daily memory writes publish a complete replacement file under that lock, so concurrent readers see the previous or new complete file rather than a partially appended record. Appending a row therefore rewrites the day file (in addition to the existing timestamp-uniqueness read). On Windows, a reader handle that prevents replacement can make the write refuse after the replacement retry window; the previous bytes remain intact and the caller can retry once the handle closes. This publication rule applies to daily memory files, not append-only evidence, use, rejection, or audit logs; [#198](https://github.com/abogartz/opencode-self-improvement/issues/198) tracks the broader read boundary.

The lock covers one **file**, not the store directory. Two sessions writing different days of the same store therefore do not wait on each other. A directory-wide lock was tried first and lost writes: a whole-file publish waits up to two seconds on Windows for a reader to let go of the destination, and with one lock for the directory that wait stops every other writer in the store. Per file it stops only the writers of that file, which is what the publish's safety check needs. The cost is a database plus its write-ahead log per locked file; they exist only while a connection is open, and the number of open connections is bounded. A writer never holds two file locks at once, and batches that must serialize a whole read-then-supersede sequence (`memory_update`, `memory_merge_review`) take a separate named lock (`.store-batch.update-order.sqlite`), always before the file locks their steps take — so a batch never holds a file lock across its whole run.

Two unsupported placements. The write-ahead log needs mmap'd shared memory, which SQLite does not provide on network filesystems, so a memory root on SMB, NFS or a OneDrive-mounted folder is **not supported**: writes there can report a disk I/O error rather than serialise. Configure `OPENCODE_MEMORY_DIR` on local disk. And during the update that introduced this lock, a session still running the previous release honours `<date>.logfmt.lock` while an updated session honours the SQLite lock, so those two do not exclude each other until every running session has restarted.

On POSIX systems, new store directories use owner-only `0700` permissions and new files use `0600` (subject to a more restrictive umask) — including temporary replacements, snapshots, locks, status files and append-only logs. Accessing an existing store removes group/other permissions from its root, and tightens directories and files as they are written. Old descendants are not migrated recursively: a tightened root already stops other users from reaching them.

Three limits on that guarantee, stated plainly because they are privacy limits.

1. If chmod reports `EPERM`, `EROFS`, `EOPNOTSUPP` or `ENOSYS` — an immutable root, a foreign-owned root, or a mount without chmod support — reads stay available under the existing permissions, so owner-only traversal is **not** guaranteed. Fix ownership, mount support or permissions outside the plugin when that guarantee is required.
2. The modes do not revoke handles that are already open, and they do not protect copies or hard links made outside the private root.
3. On Windows the plugin changes no ACLs; privacy there depends entirely on the directory's existing ACL.

A store root that is itself a symlink is refused; configure its real directory instead. Ancestors outside the store are left as they are.
