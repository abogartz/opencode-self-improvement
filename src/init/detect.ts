// detect — split from src/init.ts (#168 domain restructure). Declaration bodies are unchanged.
// Repository init: ensure the codebase-memory graph exists for this repo and
// re-derive build/test command memories through the write gate. Deterministic
// (no model calls): the graph binary is spawned one-shot via `cli`, manifests
// are parsed locally, and every write goes through the 4-gate pipeline with the
// `trusted` flag (plugin-authored bookkeeping, not model claims). Degrades
// gracefully when the binary or git is absent, so install-from-scratch still
// writes script memories.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { cbmBin } from "../core/config/paths.ts";
import { run } from "./run.ts";

export interface ScriptRecord {
  key: string;
  cmd: string;
  source: string;
}

export interface GraphStatus {
  action: "indexed" | "unavailable" | "index-failed";
  name?: string;
  mode: string;
}

const NOTABLE_KEYS = ["test", "e2e", "lint", "typecheck", "check", "build", "format"];

function isNotable(key: string): boolean {
  return NOTABLE_KEYS.includes(key) || NOTABLE_KEYS.some((k) => key.startsWith(k));
}

function runSync(cmd: string[], cwd: string): { ok: boolean; out: string } {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    const out = p.stdout?.toString() ?? "";
    const err = p.stderr?.toString() ?? "";
    return { ok: p.exitCode === 0, out: (out || err).trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

export async function gitRootOf(dir: string): Promise<string> {
  const r = runSync(["git", "rev-parse", "--show-toplevel"], dir);
  return r.ok && r.out ? r.out : dir;
}

export async function gitHead(root: string): Promise<string> {
  const r = runSync(["git", "rev-parse", "--short", "HEAD"], root);
  return r.ok && r.out ? r.out : "-";
}

async function readText(root: string, file: string): Promise<string | null> {
  const p = join(root, file);
  if (!existsSync(p)) return null;
  try {
    return await Bun.file(p).text();
  } catch {
    return null;
  }
}

async function detectPackageScripts(root: string, records: ScriptRecord[]): Promise<void> {
  const text = await readText(root, "package.json");
  if (!text) return;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text);
  } catch {
    return;
  }
  if (!pkg.scripts || typeof pkg.scripts !== "object") return;
  const seen = new Set<string>();
  for (const name of Object.keys(pkg.scripts as Record<string, unknown>)) {
    if (seen.has(name) || !isNotable(name.toLowerCase())) continue;
    seen.add(name);
    records.push({ key: name, cmd: `npm run ${name}`, source: "package.json" });
  }
}

async function detectMakeTargets(root: string, records: ScriptRecord[]): Promise<void> {
  const targetRe = /^([A-Za-z0-9_-]+)\s*:/;
  const seen = new Set<string>();
  for (const file of ["Makefile", "Justfile"]) {
    const text = await readText(root, file);
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (/^[\t ]|^\s*#|^\./.test(line)) continue;
      const m = targetRe.exec(line);
      if (!m) continue;
      const name = m[1].toLowerCase();
      if (!isNotable(name) || seen.has(name)) continue;
      seen.add(name);
      const runner = file === "Justfile" ? "just" : "make";
      records.push({ key: name, cmd: `${runner} ${m[1]}`, source: file });
    }
  }
}

async function detectLangManifests(root: string, records: ScriptRecord[]): Promise<void> {
  if (existsSync(join(root, "Cargo.toml"))) {
    records.push({ key: "test", cmd: "cargo test", source: "Cargo.toml" });
  }
  const py = await readText(root, "pyproject.toml");
  if (py && /pytest|tool\.pytest|\[tool\]\.poetry/.test(py)) {
    records.push({ key: "test", cmd: "pytest", source: "pyproject.toml" });
  }
}

export async function detectScripts(root: string): Promise<ScriptRecord[]> {
  const records: ScriptRecord[] = [];
  await detectPackageScripts(root, records);
  await detectMakeTargets(root, records);
  await detectLangManifests(root, records);
  return records.slice(0, 8);
}

async function cbmProject(bin: string, root: string): Promise<{ name: string } | null> {
  const r = await run(
    [bin, "cli", "--quiet", "list_projects", "--format", "json", "--metadata-only"],
    root,
  );
  if (!r.ok || !r.out) return null;
  try {
    const env = JSON.parse(r.out) as { projects?: { name: string; root_path: string }[] };
    const hit = env.projects?.find((p) => p.root_path === root);
    return hit ? { name: hit.name } : null;
  } catch {
    return null;
  }
}

export async function ensureGraph(root: string, mode: string, force: boolean): Promise<GraphStatus> {
  const bin = cbmBin() ?? "codebase-memory-mcp";
  const existing = await cbmProject(bin, root);
  if (existing && !force) return { action: "indexed", name: existing.name, mode };
  const r = await run(
    [bin, "cli", "--quiet", "index_repository", "--repo-path", root, "--mode", mode],
    root,
  );
  if (!r.ok) return { action: "unavailable", mode };
  const after = await cbmProject(bin, root);
  return { action: after ? "indexed" : "index-failed", name: after?.name, mode };
}
