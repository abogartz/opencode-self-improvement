// POSIX modes protect local store data, not Windows ACLs. Never follow a
// final-component link while tightening permissions, or add owner access that
// an operator deliberately removed (e.g. a read-only store).
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export function tightenDirectory(path: string): void {
  if (process.platform === "win32") return;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    const mode = fstatSync(fd).mode & 0o7777;
    const privateMode = mode & 0o700;
    if (mode !== privateMode) {
      try {
        fchmodSync(fd, privateMode);
      } catch (err) {
        // A readable store may be immutable, foreign-owned, or on a mount
        // without chmod support. Keep reads available without claiming that
        // its existing permissions were tightened. Open-time refusals above
        // remain policy errors; unexpected I/O failures still propagate.
        const code = (err as NodeJS.ErrnoException).code;
        if (!code || !["EPERM", "EROFS", "EOPNOTSUPP", "ENOSYS"].includes(code)) throw err;
      }
    }
  } finally {
    closeSync(fd);
  }
}

// Status publication keeps its existing Bun.write scheduling. Claim/tighten
// the file before that write, without first exposing its contents at 0644.
export function preparePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  tightenDirectory(dirname(path));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (process.platform !== "win32") fchmodSync(fd, fstatSync(fd).mode & 0o600);
  } finally {
    closeSync(fd);
  }
}
