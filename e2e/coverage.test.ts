// The mechanical gate for #241: the characterization matrix may never silently
// reopen. No host is booted here — this test PARSES the plugin's registrations
// straight out of src/index.ts and the scenario sources out of e2e/*.test.ts,
// so the two can only drift apart through a visible red:
//
// 1. Every tool the plugin registers (`name: "memory_*"`) must be exercised by
//    a scripted tool_call somewhere in the e2e suite (call-site scan). The
//    same scan pins MEMORY_TOOLS in support/harness.ts to the registration set.
// 2. Every event hook the plugin subscribes to (session.*, tool.*, event
//    subscription) must be tagged by at least one scenario comment:
//        // @covers hook:session.compaction
//    placed directly above the test("Scenario: ...") that characterizes it.
// 3. Tags can never rot: every tag must name a hook that is actually
//    registered today.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_TOOLS } from "./support/harness.ts";

const E2E_DIR = import.meta.dir;
const SRC_ROOT = join(E2E_DIR, "..", "src");

/** Registration sources: every module under src/, recursively (#168 layout). */
function registrationSources(): string {
  let text = "";
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".ts") && f.name !== "deps.ts" && f.name !== "registry.ts") text += readFileSync(p, "utf8");
    }
  };
  walk(SRC_ROOT);
  return text;
}

const REG_SRC = registrationSources();

/** Tool names as registered by the plugin (index.ts + src/tools/*). */
function registeredTools(): string[] {
  const out = new Set<string>();
  for (const m of REG_SRC.matchAll(/name:\s*"(memory_[a-z_]+)"/g)) out.add(m[1]);
  return [...out].sort();
}

/**
 * Event hooks as subscribed in the plugin source:
 * `ctx.session?.hook("prompt", …)`, `ctx.tool?.hook("execute.before", …)`,
 * and the `ctx.event?.subscribe` stream.
 */
function registeredHooks(): string[] {
  const out = new Set<string>();
  for (const m of REG_SRC.matchAll(/ctx\.session\??\.hook\(\s*"([a-z.]+)"/g))
    out.add(`session.${m[1]}`);
  for (const m of REG_SRC.matchAll(/ctx\.tool\??\.hook\(\s*"([a-z.]+)"/g))
    out.add(`tool.${m[1]}`);
  if (/ctx\.event\??\.subscribe/.test(REG_SRC)) out.add("event.subscribe");
  return [...out].sort();
}

interface ScenarioFile {
  name: string;
  source: string;
  scenarios: { title: string; covers: string[] }[];
}

function scenarioFiles(): ScenarioFile[] {
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".test.ts") && f !== "coverage.test.ts")
    .map((name) => {
      const source = readFileSync(join(E2E_DIR, name), "utf8");
      const scenarios: { title: string; covers: string[] }[] = [];
      // Walk every test("…") and collect @covers tags from the comment block
      // that ends immediately above it.
      // Split on CRLF too: a Windows checkout with core.autocrlf would
      // otherwise leave a trailing \r on every line and break the tag scan.
      const lines = source.split(/\r?\n/);
      const pending: string[] = [];
      for (const line of lines) {
        const tag = /@covers\s+(.+)$/.exec(line);
        if (tag && /^\s*\/\//.test(line)) {
          pending.push(...tag[1].trim().split(/\s+/));
          continue;
        }
        const t = /test\(\s*"([^"]+)"/.exec(line);
        if (t) {
          scenarios.push({ title: t[1], covers: pending.splice(0) });
          continue;
        }
        // Any other code line closes the comment block: tags must be adjacent.
        if (line.trim() !== "" && !/^\s*\/\//.test(line) && pending.length) pending.length = 0;
      }
      return { name, source, scenarios };
    });
}

describe("Feature: characterization-matrix gate (#241)", () => {
  const tools = registeredTools();
  const hooks = registeredHooks();
  const files = scenarioFiles();

  test("the plugin registers the expected tool surface", () => {
    // A registration list this small needs its own tripwire: 14 tools today.
    expect(tools.length).toBe(14);
    // load.test.ts asserts these reach the model on every load; it can only
    // do that if it is the same set the source registers.
    expect([...MEMORY_TOOLS].sort()).toEqual(tools);
  });

  test("every registered tool is exercised by a real-host scenario", () => {
    const exercised = new Set<string>();
    for (const f of files)
      for (const m of f.source.matchAll(/call\(\s*"[^"]+"\s*,\s*"(memory_[a-z_]+)"/g))
        exercised.add(m[1]);
    const missing = tools.filter((t) => !exercised.has(t));
    expect(missing, `tools with no scripted call in e2e/: ${missing.join(", ")}`).toEqual([]);
  });

  test("every registered event hook has a tagged scenario", () => {
    const tagged = new Map<string, string[]>();
    for (const f of files)
      for (const s of f.scenarios)
        for (const c of s.covers)
          if (c.startsWith("hook:")) tagged.set(c.slice(5), [...(tagged.get(c.slice(5)) ?? []), `${f.name}: ${s.title}`]);
    const missing = hooks.filter((h) => !tagged.has(h));
    expect(missing, `hooks with no @covers tag: ${missing.join(", ")}`).toEqual([]);
  });

  test("every @covers tag names a hook that is registered today", () => {
    const stale: string[] = [];
    for (const f of files)
      for (const s of f.scenarios)
        for (const c of s.covers)
          if (c.startsWith("hook:") && !hooks.includes(c.slice(5)))
            stale.push(`${f.name}: ${s.title} -> ${c}`);
    expect(stale, `@covers tags pointing at unregistered hooks: ${stale.join("; ")}`).toEqual([]);
  });
});
