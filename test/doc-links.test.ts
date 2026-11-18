// The README is shipped; the repository is not. A relative link to a file the
// package does not carry therefore works for anyone reading it on GitHub and
// dead-ends for anyone reading it in `node_modules`, which is invisible to the
// person who adds the link. Both halves are checked: every relative target
// exists in the checkout, and everything it points at is inside the published
// `files` list.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  files: string[];
};

/** npm adds these to every tarball whether or not `files` names them. */
const ALWAYS = new Set(["README.md", "LICENSE", "package.json"]);

/** Forward slashes on every platform: these names are compared as paths. */
function posix(p: string): string {
  return p.split(sep).join("/");
}

function markdownFiles(): string[] {
  const out = ["README.md"];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".md"))
        out.push(posix(relative(ROOT, p)).replace(/^\.\.\//, ""));
    }
  };
  walk(join(ROOT, "docs"));
  return out;
}

const FILES = markdownFiles();

/** Every non-external link target, resolved against the linking file. */
function relativeLinks(): { from: string; raw: string; to: string }[] {
  const out: { from: string; raw: string; to: string }[] = [];
  for (const file of FILES) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const raw = m[1];
      if (/^(https?:|mailto:|#)/i.test(raw)) continue;
      const target = raw.split("#")[0];
      out.push({
        from: file,
        raw,
        // `../README.md` from inside docs/ names the same shipped file as
        // `README.md`, so it is compared after resolution, not as written.
        to: posix(normalize(join(dirname(file), target))),
      });
    }
  }
  return out;
}

function isShipped(path: string): boolean {
  const p = path.replace(/^\.\//, "");
  if (ALWAYS.has(p)) return true;
  return PKG.files.some(
    (entry) => p === entry || p.startsWith(entry.replace(/\/$/, "") + "/"),
  );
}

describe("documentation links", () => {
  test("the suite is looking at the README and the docs", () => {
    // A walk that finds nothing would make every check below pass vacuously.
    expect(FILES).toContain("README.md");
    expect(FILES.filter((f) => f.startsWith("docs/")).length).toBeGreaterThan(
      5,
    );
    expect(relativeLinks().length).toBeGreaterThan(5);
  });

  test("every relative link resolves in the checkout", () => {
    const broken = relativeLinks()
      .filter(({ to }) => !existsSync(join(ROOT, to)))
      .map(({ from, raw }) => `${from} -> ${raw}`);
    expect(broken).toEqual([]);
  });

  test("every linked file is inside the published `files` list", () => {
    // A reader of an installed package has no repository next to the README, so
    // a link outside `files` is a link to a path that does not exist for them.
    const unshipped = relativeLinks()
      .filter(({ to }) => !isShipped(to))
      .map(({ from, raw }) => `${from} -> ${raw}`);
    expect(unshipped).toEqual([]);
  });

  test("docs are part of the published surface", () => {
    // Stated directly, so removing `docs` from `files` fails by name rather
    // than by an empty link list.
    expect(PKG.files).toContain("docs");
  });
});
