// Contract (#24): a path a model names is attacker-selectable text, so the two
// model-facing path arguments — memory_export's `file` (an arbitrary WRITE)
// and memory_import's `file` (an arbitrary READ) — are confined to the store.
// Exports may only land under <memory-root>/exports; imports may only be read
// from inside <memory-root>. Containment is lexical AND real-path (a symlink
// inside the root cannot carry the request out), it runs before the filesystem
// is touched, and a rejection never says whether the path exists.
//
// These scenarios are red on the pre-fix revision: there, `file` went straight
// to Bun.write / Bun.file, so an export clobbered ~/.gitconfig, a relative path
// landed in the host process's cwd, and import read any path on disk.
//
// Hermetic: temp OPENCODE_MEMORY_DIR / OPENCODE_COMMANDS_DIR, no network, no
// real home directory is written to (every `~` probe is asserted ABSENT).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportsDir, memoryRoot } from "../src/core/config/paths.ts";
import { expandHome, isWithin, resolveContained } from "../src/store/containment.ts";
import { exportMemories, writeExport } from "../src/portable/export.ts"
import { importMemories } from "../src/portable/import.ts";
import { resetState } from "../src/core/state.ts";
import { setRepoScope } from "../src/identity/repokey.ts";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";

// The harness types tools as a loose record; this fails loudly at the call site
// instead of papering over the optionality with a non-null assertion.
function toolOf(loaded: LoadedPlugin, name: string) {
  const t = loaded.tool[name];
  if (!t) throw new Error(`${name} is not registered`);
  return t.execute;
}

let root: string;
let liveRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-contain-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  liveRoot = join(root, "repo");
  mkdirSync(liveRoot, { recursive: true });
  mkdirSync(memoryRoot(), { recursive: true });
  setRepoScope(null);
  resetState();
});

afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  delete process.env.OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// Symlinks need Developer Mode/admin on Windows; a directory junction needs no
// elevation and exercises the same realpath escape (same fallback as
// test/undo.test.ts).
function makeLink(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath);
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "EPERM")) throw err;
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(target, linkPath, "junction");
  }
}

// Two fixtures below build a symlink directly — a junction cannot replace them
// (one must dangle, one must point at a FILE) — and creating a symlink needs
// Developer Mode or admin on Windows, so on an unprivileged box the fixture's
// own symlinkSync throws EPERM before resolveContained is ever called (#147).
// Skip on the machine's actual capability, probed once with the same call the
// fixtures make — not on the platform label: GitHub's Windows runners hold the
// privilege (test-windows runs the rest of this file green) and keep executing
// these tests; unprivileged dev boxes stop paying a fake-red triage tax.
const CAN_SYMLINK = (() => {
  const probe = mkdtempSync(join(tmpdir(), "osi-symlink-cap-"));
  try {
    symlinkSync(join(probe, "nothing-here"), join(probe, "probe"));
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EPERM") return false;
    throw err;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const outsidePayload = (marker: string) =>
  `${[
    JSON.stringify({ _export: "opencode-self-improvement", version: 1, count: 1 }),
    JSON.stringify({ type: "learning", scope: "s", content: marker }),
  ].join("\n")}\n`;

// The rejection text for a call that must fail, so two failures can be compared.
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a rejection, got a success");
}

// --- the helper itself ---------------------------------------------------------

describe("isWithin", () => {
  test("the root is within itself; siblings and parents are not", () => {
    const base = resolve("/store");
    expect(isWithin(base, base)).toBe(true);
    expect(isWithin(base, resolve("/store/exports/a.jsonl"))).toBe(true);
    expect(isWithin(base, resolve("/other"))).toBe(false);
    expect(isWithin(base, resolve("/"))).toBe(false);
    // A sibling whose name merely starts with the root's text.
    expect(isWithin(base, resolve("/storehouse"))).toBe(false);
  });
});

describe("expandHome", () => {
  test("`~` and `~/…` become the home directory; everything else is untouched", () => {
    expect(expandHome("~")).toBe(resolve(homedir()));
    expect(expandHome("~/.gitconfig")).toBe(resolve(homedir(), ".gitconfig"));
    expect(expandHome("a/b")).toBe("a/b");
    // Only a leading `~` component counts.
    expect(expandHome("a~b")).toBe("a~b");
    expect(expandHome("./~x/y")).toBe("./~x/y");
  });
});

describe("resolveContained", () => {
  test("a relative request resolves against the root, never the process cwd", async () => {
    const got = await resolveContained("out.jsonl", exportsDir(), { label: "t" });
    expect(got).toBe(join(exportsDir(), "out.jsonl"));
    expect(got).toBe(resolve(exportsDir(), "out.jsonl"));
  });

  test("a nested request may create directories inside the root", async () => {
    const got = await resolveContained("sub/deep/out.jsonl", exportsDir(), { label: "t" });
    expect(got).toBe(join(exportsDir(), "sub/deep/out.jsonl"));
  });

  test("absolute paths, traversal and `~` are rejected before any filesystem call", async () => {
    for (const bad of [
      join(root, "elsewhere.jsonl"), // absolute, outside
      "../outside.jsonl", // traversal
      "a/../../outside.jsonl", // traversal after a step in
      "~/.gitconfig", // home expansion, then rejected
      "~",
      resolve(homedir(), ".ssh", "authorized_keys"),
    ]) {
      await expect(resolveContained(bad, exportsDir(), { label: "t" }), bad).rejects.toThrow(
        /must stay inside|escapes/,
      );
    }
  });

  test("empty and control-character requests are rejected", async () => {
    // Checked AFTER trimming, which is only safe because trim() removes nothing
    // but whitespace: NUL and the non-whitespace C0/C1 controls below all
    // survive it and are still refused. If trim() ever learned to eat these,
    // this list is the guard.
    for (const bad of ["", "   ", "a\u0000b.jsonl", "a\tb", "\u0085x.jsonl", "x.jsonl\u001f"]) {
      await expect(resolveContained(bad, exportsDir(), { label: "t" }), JSON.stringify(bad))
        .rejects.toThrow(/must not be empty|must not contain control characters/);
    }
  });

  test("surrounding whitespace is trimmed rather than refused", async () => {
    // A model that emits "x.jsonl\n" as a string argument means that file.
    // Refusing it as a control character is a trap with no security upside.
    expect(await resolveContained("  out.jsonl\n ", exportsDir(), { label: "t" })).toBe(
      join(exportsDir(), "out.jsonl"),
    );
  });

  test.skipIf(!CAN_SYMLINK)(
    "a dangling symlink in the path is refused, not waved through",
    async () => {
    // realAncestor() must lstat(), not stat(): stat() follows this link to
    // nothing, the walk skips past it as "missing", and the request comes back
    // ACCEPTED — leaving mkdir() to fail on the link with a raw errno.
    mkdirSync(exportsDir(), { recursive: true });
    symlinkSync(join(root, "nothing-here"), join(exportsDir(), "dangling"));
    await expect(
      resolveContained("dangling/out.jsonl", exportsDir(), { label: "t" }),
    ).rejects.toThrow(/could not be resolved/);
  });

  test("a symlinked parent inside the root cannot carry the request out", async () => {
    const outside = join(root, "escape-target");
    mkdirSync(outside, { recursive: true });
    mkdirSync(exportsDir(), { recursive: true });
    makeLink(outside, join(exportsDir(), "link"));
    await expect(
      resolveContained("link/payload.jsonl", exportsDir(), { label: "t" }),
    ).rejects.toThrow(/symbolic link/);
    expect(existsSync(join(outside, "payload.jsonl"))).toBe(false);
  });

  // File symlinks need elevation on Windows and a junction cannot stand in for
  // one; the in-store case below pins the same branch on every platform.
  test.skipIf(process.platform === "win32")(
    "a symlink as the final component is rejected, not followed",
    async () => {
      const victim = join(root, "victim.jsonl");
      writeFileSync(victim, "do not overwrite me\n");
      mkdirSync(exportsDir(), { recursive: true });
      makeLink(victim, join(exportsDir(), "out.jsonl"));
      await expect(resolveContained("out.jsonl", exportsDir(), { label: "t" })).rejects.toThrow(
        /symbolic link/,
      );
      expect(readFileSync(victim, "utf8")).toBe("do not overwrite me\n");
    },
  );

  test("even a link that stays INSIDE the root is not followed", async () => {
    // The real-path check would ALLOW this one — the regular-file rule is what
    // stops an export from overwriting a store file through a link somebody
    // else placed. Asserted on the link itself so Windows can exercise it with
    // an unprivileged junction; the message is matched loosely because a
    // junction reads as a reparse point there, so either branch refuses it.
    // On Linux/macOS it refuses with "must not be a symbolic link".
    mkdirSync(exportsDir(), { recursive: true });
    const inside = join(exportsDir(), "inside");
    mkdirSync(inside, { recursive: true });
    makeLink(inside, join(exportsDir(), "alias"));
    await expect(resolveContained("alias", exportsDir(), { label: "t" })).rejects.toThrow(
      /symbolic link|not a regular file/,
    );
    expect(existsSync(inside)).toBe(true);
  });

  test("a directory is not an acceptable target", async () => {
    mkdirSync(join(exportsDir(), "adir"), { recursive: true });
    await expect(resolveContained("adir", exportsDir(), { label: "t" })).rejects.toThrow(
      /not a regular file/,
    );
  });

  test("rejections do not reveal whether the path exists", async () => {
    const outside = join(root, "i-exist-outside.jsonl");
    writeFileSync(outside, "x\n");
    const missing = join(root, "i-do-not-exist.jsonl");
    const hit = await refusal(() => resolveContained(outside, exportsDir(), { label: "t" }));
    const miss = await refusal(() => resolveContained(missing, exportsDir(), { label: "t" }));
    // Same wording for both, once the caller's own name is masked out: no
    // existence oracle for anything outside the root.
    expect(hit.replace("i-exist-outside", "X")).toBe(miss.replace("i-do-not-exist", "X"));
  });

  // Which traversal failures a platform reports at all is OS behavior, not
  // ours: Windows turns ENOTDIR/ELOOP into ENOENT, so the path simply looks
  // absent and containment has nothing to wrap.
  test.skipIf(process.platform === "win32")(
    "raw filesystem errors never reach the caller",
    async () => {
    // ENOTDIR and ELOOP used to surface as Bun's own text — errno plus the full
    // resolved path — straight into a model-facing tool result.
    writeFileSync(join(memoryRoot(), "status.json"), "{}\n");
    symlinkSync(join(memoryRoot(), "loop-a"), join(memoryRoot(), "loop-b"));
    symlinkSync(join(memoryRoot(), "loop-b"), join(memoryRoot(), "loop-a"));
    for (const p of [
      join(memoryRoot(), "status.json", "x.jsonl"), // ENOTDIR
      join(memoryRoot(), "loop-a", "x.jsonl"), // ELOOP
    ]) {
      expect(await refusal(() => resolveContained(p, memoryRoot(), { label: "t" }))).toBe(
        "t could not be resolved",
      );
    }
    },
  );

  test("the root itself is not a destination", async () => {
    // Accepting `.` would create a REGULAR FILE named `exports` on a fresh
    // store and disable every later export, default included.
    for (const bad of [".", " . ", "./", "./."]) {
      await expect(exportMemories({ file: bad }), bad).rejects.toThrow(
        /must name a file inside the root/,
      );
    }
    expect(existsSync(exportsDir())).toBe(false);
    // …and export still works afterwards.
    expect((await exportMemories()).path.startsWith(join(memoryRoot(), "exports"))).toBe(true);
  });

  test("a root that exists as a regular file names the cause", async () => {
    // The pre-fix `file: "."` bug left exactly this state behind. Collapsing it
    // into the neutral wording is worse than useless here: the hint says "omit
    // file for the default", and the default fails for the same reason.
    writeFileSync(exportsDir(), "not a directory");
    for (const call of [() => exportMemories(), () => exportMemories({ file: "a.jsonl" })]) {
      const msg = await refusal(call);
      expect(msg).toInclude("is not a directory");
      expect(msg).not.toInclude("could not be resolved");
    }
  });

  test("a `~user` form is refused rather than creating a literal ~ directory", async () => {
    await expect(exportMemories({ file: "~nobody/x.jsonl" })).rejects.toThrow(
      /must not use a `~` home path/,
    );
    expect(existsSync(join(exportsDir(), "~nobody"))).toBe(false);
  });

  test("an exports/ that is itself a symlink cannot move the write out of the store", async () => {
    // Every check against exports/'s own realpath would pass; the outerRoot
    // check is what catches this, mirroring undo.ts's snapshots-vs-root test.
    rmSync(exportsDir(), { recursive: true, force: true });
    const outside = join(root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    makeLink(outside, exportsDir());
    await expect(exportMemories({ file: "via-link.jsonl" })).rejects.toThrow(/escapes the store root/);
    expect(existsSync(join(outside, "via-link.jsonl"))).toBe(false);
    // The argument-free default is the call a model makes without knowing
    // anything about the layout, so it must not be the one that skips the check.
    await expect(exportMemories()).rejects.toThrow(/escapes the store root/);
    expect(readdirSync(outside)).toEqual([]);
  });

  test.skipIf(!CAN_SYMLINK)(
    "a link to another file INSIDE the root is refused, not followed",
    async () => {
    // The realpath check passes (both ends are inside); only an lstat at the
    // final component sees the link. A stat() here would wave it through and
    // clobber the target.
    mkdirSync(exportsDir(), { recursive: true });
    const target = join(exportsDir(), "someone-else.jsonl");
    writeFileSync(target, "existing export\n");
    symlinkSync(target, join(exportsDir(), "mine.jsonl"));
    await expect(exportMemories({ file: "mine.jsonl" })).rejects.toThrow(/must not be a symbolic link/);
    expect(readFileSync(target, "utf8")).toBe("existing export\n");
  });

  // libuv does not implement O_NOFOLLOW on Windows — the open follows the link
  // there — so this guarantee is POSIX-only and the Windows leg cannot pin it.
  test.skipIf(process.platform === "win32")(
    "the writer itself refuses to follow a link (O_NOFOLLOW)",
    async () => {
    // The classic swap-in-the-window attack, made deterministic: containment
    // would reject this path earlier, so the flag is what stands between a
    // link planted after the check and the target it points at.
    mkdirSync(exportsDir(), { recursive: true });
    const victim = join(exportsDir(), "target.jsonl");
    writeFileSync(victim, "original\n");
    const link = join(exportsDir(), "swapped.jsonl");
    symlinkSync(victim, link);
    await expect(writeExport(link, "evil\n")).rejects.toThrow();
    expect(readFileSync(victim, "utf8")).toBe("original\n");
    },
  );

  // Windows has no POSIX permission bits and reports every writable file 0666.
  test.skipIf(process.platform === "win32")(
    "an export is written 0600 — it is a plaintext copy of the whole store",
    async () => {
      const res = await exportMemories();
      expect(statSync(res.path).mode & 0o777).toBe(0o600);
    },
  );

  // open()'s mode only applies at creation, so re-exporting over a file that
  // already existed would otherwise leave a 0644 export world-readable.
  test.skipIf(process.platform === "win32")(
    "replacing an existing export tightens its mode to 0600",
    async () => {
      mkdirSync(exportsDir(), { recursive: true });
      const p = join(exportsDir(), "preexisting.jsonl");
      writeFileSync(p, "old\n");
      chmodSync(p, 0o644);
      expect(statSync(p).mode & 0o777).toBe(0o644);
      await writeExport(p, "new\n");
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(readFileSync(p, "utf8")).toBe("new\n");
    },
  );

  test("a failing write is reported in our words, with the errno kept", async () => {
    // Past containment the path is confined, so the errno is not an oracle — it
    // is the operator's only diagnostic. What must not leak is the runtime's own
    // sentence, verbatim, into a model-facing tool result.
    mkdirSync(exportsDir(), { recursive: true });
    chmodSync(exportsDir(), 0o500);
    try {
      // Skip honestly where the mode is ignored (running as root).
      await writeExport(join(exportsDir(), "probe.jsonl"), "x\n");
      return;
    } catch {
      const msg = await refusal(() => exportMemories({ file: "x.jsonl" }));
      expect(msg).toInclude("memory_export could not write");
      expect(msg).toInclude("EACCES");
      expect(msg).not.toMatch(/permission denied, (open|mkdir)/);
    } finally {
      chmodSync(exportsDir(), 0o700);
    }
  });

  test("the escape hatch skips containment but not input hygiene", async () => {
    const anywhere = join(root, "anywhere.jsonl");
    const got = await resolveContained(anywhere, exportsDir(), {
      label: "t",
      allowOutside: true,
    });
    expect(got).toBe(anywhere);
    await expect(
      resolveContained("a\u0000b", exportsDir(), { label: "t", allowOutside: true }),
    ).rejects.toThrow(/control characters/);
    // `~` is still expanded, so the hatch cannot smuggle a literal "~" dir.
    expect(await resolveContained("~", exportsDir(), { label: "t", allowOutside: true })).toBe(
      resolve(homedir()),
    );
  });
});

// --- export: the write boundary ------------------------------------------------

describe("memory_export destination", () => {
  test("the default lands under exports/", async () => {
    const res = await exportMemories();
    expect(res.path.startsWith(join(memoryRoot(), "exports"))).toBe(true);
    expect(existsSync(res.path)).toBe(true);
  });

  test("an explicit destination inside exports/ is honored, including nested dirs", async () => {
    const direct = join(exportsDir(), "chosen.jsonl");
    expect((await exportMemories({ file: direct })).path).toBe(direct);
    const nested = await exportMemories({ file: "deep/dir.jsonl" });
    expect(nested.path).toBe(join(exportsDir(), "deep/dir.jsonl"));
    expect(existsSync(nested.path)).toBe(true);
  });

  test("writing outside the store is refused and nothing is created", async () => {
    const victim = join(root, "victim.jsonl");
    const dotfile = join(root, ".gitconfig");
    writeFileSync(dotfile, "[user]\n  name = keep me\n");
    for (const bad of [victim, dotfile, join(root, "..", "escape.jsonl"), "~/.osi-probe.jsonl"]) {
      await expect(exportMemories({ file: bad })).rejects.toThrow(/memory_export file/);
    }
    expect(existsSync(victim)).toBe(false);
    expect(readFileSync(dotfile, "utf8")).toBe("[user]\n  name = keep me\n");
    // A `~` request must not fall back to creating a literal "~" directory.
    expect(existsSync(join(exportsDir(), "~"))).toBe(false);
    expect(existsSync(join(process.cwd(), "~"))).toBe(false);
  });

  test("a rejected export leaves no file at all, not even a header", async () => {
    // The destination is settled before the store is read, so a refusal cannot
    // be a partial write or a row-count oracle.
    const target = join(exportsDir(), "legit.jsonl");
    mkdirSync(exportsDir(), { recursive: true });
    writeFileSync(target, "sentinel\n");
    await expect(exportMemories({ file: "../legit.jsonl" })).rejects.toThrow(/memory_export file/);
    expect(readFileSync(target, "utf8")).toBe("sentinel\n");
  });

  test("an empty destination is a caller bug, not a silent redirect to the default", async () => {
    await expect(exportMemories({ file: "  " })).rejects.toThrow(/must not be empty/);
  });

  test("the tool reports a refused destination as a soft message, not a thrown call", async () => {
    const loaded = await loadPlugin(liveRoot);
    const out = await toolOf(loaded, "memory_export")({ file: join(root, "nope.jsonl") });
    expect(out).toContain("memory_export failed");
    expect(out).toContain("must stay inside");
    expect(existsSync(join(root, "nope.jsonl"))).toBe(false);
    await loaded.cleanup();
  });
});

// --- import: the read boundary -------------------------------------------------

describe("memory_import source", () => {
  test("a file inside the memory root is read", async () => {
    const file = join(memoryRoot(), "in.jsonl");
    writeFileSync(file, outsidePayload("One durable fact about the build pipeline."));
    const seen: string[] = [];
    const tally = await importMemories(file, async (c) => {
      seen.push(c.content);
      return { action: "promoted" };
    });
    expect(tally.promoted).toBe(1);
    expect(seen).toHaveLength(1);
  });

  test("an arbitrary path outside the store is refused and the gate never runs", async () => {
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, outsidePayload("MARKER_OUTSIDE_ROW"));
    let gateCalls = 0;
    await expect(
      importMemories(outside, async () => {
        gateCalls++;
        return { action: "promoted" };
      }),
    ).rejects.toThrow(/memory_import file.*must stay inside/);
    expect(gateCalls).toBe(0);
  });

  test("traversal out of the root is refused, and is not reported as missing", async () => {
    writeFileSync(join(root, "day.jsonl"), outsidePayload("MARKER"));
    await expect(importMemories("../day.jsonl", async () => ({ action: "promoted" }))).rejects.toThrow(
      /must stay inside/,
    );
  });

  test("a symlink inside the store pointing outside is refused", async () => {
    // Linked through a DIRECTORY so Windows can exercise the same realpath
    // escape with an unprivileged junction.
    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "payload.jsonl"), outsidePayload("MARKER"));
    makeLink(outsideDir, join(memoryRoot(), "linkdir"));
    let gateCalls = 0;
    await expect(
      importMemories(join(memoryRoot(), "linkdir", "payload.jsonl"), async () => {
        gateCalls++;
        return { action: "promoted" };
      }),
    ).rejects.toThrow(/escapes/);
    expect(gateCalls).toBe(0);
  });

  test("a non-.jsonl name inside the root is refused, so the tally cannot sniff store files", async () => {
    // Day files, snapshots and the blocklist all live under the root; parsing
    // them as JSONL would report a line count even though none is an import.
    writeFileSync(join(memoryRoot(), "2026-01-02.logfmt"), "ts=x type=learning\n");
    mkdirSync(join(memoryRoot(), "snapshots"), { recursive: true });
    let gateCalls = 0;
    for (const bad of [
      join(memoryRoot(), "2026-01-02.logfmt"),
      join(memoryRoot(), "snapshots", "1-2026-01-02.logfmt"),
    ]) {
      await expect(
        importMemories(bad, async () => {
          gateCalls++;
          return { action: "promoted" };
        }),
      ).rejects.toThrow(/must be a \.jsonl export/);
    }
    expect(gateCalls).toBe(0);
  });

  test("a genuinely missing file inside the root still reports not-found", async () => {
    await expect(
      importMemories(join(memoryRoot(), "gone.jsonl"), async () => ({ action: "promoted" })),
    ).rejects.toThrow(/not found/);
  });

  test("the tool reports a refused source as a soft message", async () => {
    const loaded = await loadPlugin(liveRoot);
    const out = await toolOf(loaded, "memory_import")({ file: join(root, "x.jsonl") });
    expect(out).toContain("memory_import failed");
    expect(out).toContain("must stay inside");
    await loaded.cleanup();
  });
});

// --- the operator escape hatch -------------------------------------------------

describe("OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS", () => {
  test("unset by default: the store boundary holds", async () => {
    expect(process.env.OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS).toBeUndefined();
    await expect(exportMemories({ file: join(root, "o.jsonl") })).rejects.toThrow(
      /must stay inside/,
    );
  });

  test("when set, both directions accept paths anywhere (migration path)", async () => {
    process.env.OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS = "1";
    const out = join(root, "backup.jsonl");
    expect((await exportMemories({ file: out })).path).toBe(out);
    expect(existsSync(out)).toBe(true);
    // The store was empty, so the file holds only the header: a clean 0 rows.
    const tally = await importMemories(out, async () => ({ action: "promoted" }));
    expect(tally).toEqual({ promoted: 0, collapsed: 0, blocked: 0, skipped: 0, downgraded: 0, unaudited: 0 });
  });

  test("only an explicit truthy value opens it", async () => {
    for (const off of ["0", "false", "", "no"]) {
      process.env.OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS = off;
      await expect(exportMemories({ file: join(root, "o.jsonl") })).rejects.toThrow(
        /must stay inside/,
      );
    }
    for (const on of ["1", "true", "YES", " on "]) {
      process.env.OPENCODE_MEMORY_ALLOW_OUTSIDE_PATHS = on;
      expect((await exportMemories({ file: join(root, "o.jsonl") })).path).toBe(
        join(root, "o.jsonl"),
      );
    }
  });
});
