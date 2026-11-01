// Containment for caller-supplied filesystem paths.
//
// Every path a model can name is attacker-selectable text: memory_export's
// `file` (an arbitrary WRITE) and memory_import's `file` (an arbitrary READ).
// The rule: resolve the request against a root the plugin chose, then re-check
// the REAL path so a symbolic link anywhere along the request cannot carry it
// outside. Both checks run before any read or write, and every rejection uses
// one neutral wording — an existence oracle for the filesystem around the store
// is still a leak.
//
// src/undo.ts's snapshot restore enforces the same two-level boundary (inside
// snapshots/, and inside the memory root) with its own name grammar; it is not
// the same code path as this one and does not share its ancestor walk.
//
// Residual limits, stated rather than papered over:
//   - Checking and writing are separate syscalls. The FINAL component is
//     protected at open time by O_NOFOLLOW (see writeExport in portable.ts),
//     which closes the classic swap-a-link-over-redirect attack. An INTERMEDIATE
//     component swapped for a link inside the window is not caught; closing that
//     needs openat-relative traversal, which neither node:fs nor Bun exposes.
//   - Hardlinks are invisible to path containment: a link someone else plants
//     inside exports/ shares an inode with its target and a write through it
//     truncates that target. Containment cannot see this; it needs an owner or
//     device policy, not a path check.
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

// True when `child` is `parent` itself or lives beneath it. Both must already
// be absolute and lexically normalised (resolve()).
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

// `~` is shell syntax, not path syntax: nothing expands it here, so
// `~/.gitconfig` is an ordinary RELATIVE component and lands in a directory
// literally named "~" wherever the host process happens to be running. Expand
// the two forms a caller plausibly means, so they are judged for what they
// point at (and rejected); any other leading `~` (a `~user` form we cannot
// resolve portably) is refused outright rather than creating junk.
export function expandHome(requested: string): string {
  if (requested === "~") return resolve(homedir());
  if (requested.startsWith("~/") || requested.startsWith(`~${sep}`)) {
    return resolve(homedir(), requested.slice(2));
  }
  return requested;
}

// C0/C1 controls — including NUL, which truncates a path at the syscall layer.
// (src/sanitize.ts flattens a wider set, \p{Zl} and \p{Zp} included, because it
// guards rendered line structure; a path only has to be unrepresentable here.)
const CONTROL_CHARS = /\p{Cc}/u;

function normalize(requested: string, reject: (why: string) => string): string {
  // Trim first, then look for control characters. The order matters twice over:
  // a model that emits "x.jsonl\n" gets a working export rather than a refusal
  // about control characters, and nothing dangerous is lost by trimming, because
  // trim() removes only whitespace — NUL and the non-whitespace C1 controls that
  // actually truncate or confuse a path survive it and are still caught here.
  const trimmed = requested.trim();
  if (!trimmed) throw new Error(reject("must not be empty"));
  if (CONTROL_CHARS.test(trimmed)) throw new Error(reject("must not contain control characters"));
  const expanded = expandHome(trimmed);
  if (expanded === trimmed && expanded.split(/[/\\]/)[0]?.startsWith("~")) {
    throw new Error(reject("must not use a `~` home path"));
  }
  return expanded;
}

// realpath() the nearest EXISTING ancestor and re-join the missing remainder:
// realpath() on the full path simply fails on an export destination that does
// not exist yet, and falling back to the lexical path there would skip the
// check for exactly the case an attacker picks.
//
// Every non-ENOENT filesystem failure (ENOTDIR, ELOOP, ENAMETOOLONG, EACCES)
// becomes the same neutral rejection. Letting them through verbatim is both an
// existence oracle — ENOTDIR on `<root>/status.json/x` proves status.json is
// there — and a raw Bun error in a model-facing tool result.
async function realAncestor(path: string, reject: (why: string) => string): Promise<string> {
  const missing: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      await lstat(cursor);
      break;
    } catch (err) {
      if (!isNotFound(err)) throw new Error(reject("could not be resolved"));
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(reject("could not be resolved"));
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
  try {
    return resolve(await realpath(cursor), ...missing);
  } catch {
    throw new Error(reject("could not be resolved"));
  }
}

export interface ContainOptions {
  /** Names the caller in the error ("memory_export file"). */
  label: string;
  /** Appended to every rejection: where the caller may go instead. */
  hint?: string;
  /**
   * A second, wider root that `rootDir` itself must not reach through a link.
   * Export passes the memory root: an `exports/` that is a symlink elsewhere
   * would otherwise satisfy every check against its own realpath and still
   * write outside the store.
   */
  outerRoot?: string;
  /**
   * Skip containment (the `OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS` escape hatch
   * for out-of-band migrations). Input hygiene still applies.
   */
  allowOutside?: boolean;
}

/**
 * Resolve `requested` inside `rootDir`.
 *
 * - A relative request resolves against `rootDir`, NOT the host process's cwd.
 * - The lexical request must stay inside `rootDir`, and must not BE `rootDir`:
 *   accepting the root itself would let `.` create a regular file named
 *   `exports` and disable every later export.
 * - Existing components are resolved for real, so a link inside the root cannot
 *   step outside it: the re-joined real path must stay inside the REAL root (the
 *   root itself may legitimately be reached through a link, e.g. macOS /tmp),
 *   and inside `outerRoot` when one is given.
 * - The final component may not exist yet. If it exists it must be a regular
 *   file — never a symbolic link, never a directory.
 *
 * Returns the LEXICAL path (home-expanded), the convention undo.ts's restore
 * already follows: checks run on real paths, the write goes through the path
 * every other caller sees, so a store reached through a link keeps reporting
 * the location its caller named.
 */
export async function resolveContained(
  requested: string,
  rootDir: string,
  opts: ContainOptions,
): Promise<string> {
  const { label } = opts;
  const reject = (why: string) => `${label} ${why}${opts.hint ? ` — ${opts.hint}` : ""}`;
  const clean = normalize(requested, reject);
  // Escape hatch: still no control characters, no `~` smuggling, but the caller
  // owns the destination and a relative path means what it always meant here —
  // relative to the host process's cwd.
  if (opts.allowOutside) return resolve(clean);

  const rootAbs = resolve(rootDir);
  const reqAbs = resolve(rootAbs, clean);
  if (relative(rootAbs, reqAbs) === "") {
    throw new Error(reject("must name a file inside the root, not the root itself"));
  }
  if (!isWithin(rootAbs, reqAbs)) {
    throw new Error(reject(`must stay inside ${rootAbs} (got "${requested}")`));
  }

  // The root is resolved and validated FIRST, deliberately: with exports/ a
  // regular file, realAncestor() on the REQUEST fails ENOTDIR, and collapsing
  // that into the neutral wording would hide the one failure the caller can
  // actually fix — and the hint would send them to a default that fails the
  // same way. A root that exists as a non-directory is a broken store, not an
  // attacker's choice, so it gets a named cause.
  const realRoot = await realAncestor(rootAbs, reject);
  let rootInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    rootInfo = await lstat(realRoot);
  } catch (err) {
    if (!isNotFound(err)) throw new Error(reject("could not be resolved"));
  }
  if (rootInfo && !rootInfo.isDirectory()) {
    throw new Error(reject(`is not a directory: ${realRoot}`));
  }

  const realReq = await realAncestor(reqAbs, reject);
  if (!isWithin(realRoot, realReq)) {
    throw new Error(reject(`escapes ${rootAbs} through a symbolic link (got "${requested}")`));
  }
  if (opts.outerRoot) {
    const realOuter = await realAncestor(resolve(opts.outerRoot), reject);
    if (!isWithin(realOuter, realReq)) {
      throw new Error(reject(`escapes the store root ${realOuter} (got "${requested}")`));
    }
  }

  // Checked on the LEXICAL path: realAncestor() already followed a
  // final-component link, so only lstat() here can still see that it was one.
  // (A stat() here would pass an in-root link to an in-root file.)
  let finalInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    finalInfo = await lstat(reqAbs);
  } catch (err) {
    if (!isNotFound(err)) throw new Error(reject("could not be resolved"));
  }
  if (finalInfo) {
    if (finalInfo.isSymbolicLink()) throw new Error(reject("must not be a symbolic link"));
    if (!finalInfo.isFile()) throw new Error(reject("is not a regular file"));
  }
  return reqAbs;
}
