// Harness for the terminal merge gate: boots a fully ISOLATED real opencode
// instance (fresh XDG dirs, fresh opencode db, fresh OPENCODE_MEMORY_DIR
// store, empty HOME) pointed at the scripted fake model, runs `opencode run`
// turns against it, and exposes the event stream + provider request log for
// BDD assertions. Nothing here reads or writes the developer's real config.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const REPO = join(import.meta.dir, "..", "..");

// Every tool the plugin registers; a load failure drops one or more.
export const MEMORY_TOOLS = [
  "memory_consolidate",
  "memory_decay",
  "memory_evidence",
  "memory_export",
  "memory_forget",
  "memory_import",
  "memory_init",
  "memory_list",
  "memory_merge_review",
  "memory_recall",
  "memory_remember",
  "memory_status",
  "memory_undo",
];

// Load failures from the real host surface in stderr in these shapes; any
// hit fails a scenario even when the turn itself exits 0.
const LOAD_ERROR_RE =
  /MODULE_NOT_FOUND|Cannot find module|Failed to load plugin|plugin .* failed|Plugin .* error/i;

export interface ToolUse {
  tool: string;
  status: string;
  input: any;
  output: string;
}

export interface Run {
  exit: number | null;
  events: any[];
  stderr: string;
  toolUses: ToolUse[];
  /** Ordered output strings of every executed call of `name`. */
  outputs(name: string): string[];
  /** Final assistant text. */
  text(): string;
  errors(): any[];
}

export interface Fake {
  port: number;
  dir: string;
  setSteps(steps: Record<string, unknown[]>): void;
  reset(): Promise<void>;
  requests(): Promise<any[]>;
  stop(): void;
}

export async function startFake(): Promise<Fake> {
  const dir = mkdtempSync(join(tmpdir(), "psi-e2e-fake-"));
  const child = spawn(process.execPath, [join(import.meta.dir, "fake-model.ts")], {
    env: { ...process.env, SMOKE_DIR: dir, FAKE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  const portFile = join(dir, "port");
  let port = 0;
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      port = Number(readFileSync(portFile, "utf8"));
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (r.ok) break;
      } catch {}
    }
    await Bun.sleep(50);
  }
  if (!port) throw new Error("fake-model did not come up");
  return {
    port,
    dir,
    setSteps: (steps) => writeFileSync(join(dir, "steps.json"), JSON.stringify(steps, null, 2)),
    reset: async () => {
      await fetch(`http://127.0.0.1:${port}/__reset`, { method: "POST" });
    },
    requests: async () => (await (await fetch(`http://127.0.0.1:${port}/__requests`)).json()) as any[],
    stop: () => child.kill(),
  };
}

export interface Guest {
  root: string;
  memoryDir: string;
  projDir: string;
  env: Record<string, string>;
}

/** Fresh isolated instance dirs + project config pointing at `pluginPath`. */
export function makeGuest(fake: Fake, pluginPath: string): Guest {
  const root = mkdtempSync(join(tmpdir(), "psi-e2e-"));
  const g = (n: string) => {
    mkdirSync(join(root, n), { recursive: true });
    return join(root, n);
  };
  const cfg = g("cfg");
  const proj = g("proj");
  const memoryDir = g("memory");
  g("data");
  g("state");
  g("cache");
  const home = g("home"); // empty HOME: zero leakage of the developer's real setup

  writeFileSync(
    join(proj, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        autoupdate: false,
        snapshot: false,
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fake",
            options: { baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: "fake-key" },
            models: { scripted: { name: "Scripted" } },
          },
        },
        model: "fake/scripted",
        plugins: [{ package: pluginPath }],
      },
      null,
      2,
    ),
  );

  const bin = resolveOpencode();
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${dirname(bin)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    XDG_CONFIG_HOME: cfg,
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_MEMORY_DIR: memoryDir,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
  };
  return { root, memoryDir, projDir: proj, env };
}

export function resolveOpencode(): string {
  const bin = process.env.OPENCODE_BIN
    ? process.env.OPENCODE_BIN
    : Bun.which("opencode") ?? undefined;
  if (!bin)
    throw new Error(
      "opencode CLI not found — install it (or set OPENCODE_BIN). The terminal merge gate cannot run without a real host.",
    );
  return exeBehindCmdShim(bin);
}

// On Windows, PATH resolution usually lands on the npm cmd-shim (opencode.cmd),
// which runs the bundled opencode.exe through cmd.exe: newer runtimes reject
// spawning a .cmd with an argv array at all (Bun >= 1.4 throws EINVAL, like
// Node's CVE-2024-27980 guard), cmd.exe itself mangles quoted arguments, and
// every shim probed splits a multi-word prompt across argv. Prefer the real
// executable the shim calls; shims in other formats fall through untouched.
function exeBehindCmdShim(bin: string): string {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) return bin;
  try {
    const m = readFileSync(bin, "utf8").match(/"%(?:~?dp0)%\\([^"]+\.exe)"/i);
    if (m) {
      const target = join(dirname(bin), m[1]);
      if (existsSync(target)) return target;
    }
  } catch {
    // unreadable shim: spawn it and hope the runtime allows .cmd
  }
  return bin;
}

/** One `opencode run` turn against the scripted model. */
export async function turn(
  fake: Fake,
  guest: Guest,
  prompt: string,
  timeoutMs = 180_000,
): Promise<Run> {
  await fake.reset(); // per-run episode: clean counters + clean request log
  // Native spawn, not node:child_process: on Windows the resolved CLI is
  // often the npm cmd-shim, which node's spawn rejects outright (EINVAL) on
  // newer runtimes, while Bun's own spawn still runs it (with quoting kept
  // correct); resolveOpencode() usually has already unwrapped it to the exe.
  const child = Bun.spawn(
    [resolveOpencode(), "run", "--standalone", "--format", "json", "-m", "fake/scripted", prompt],
    { cwd: guest.projDir, env: guest.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const reading = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).catch(() => ["", ""] as [string, string]); // pipes die with a killed child
  let killer: ReturnType<typeof setTimeout> | undefined;
  const timedOut: boolean = await Promise.race([
    new Promise<true>((res) => {
      killer = setTimeout(() => {
        child.kill(9);
        res(true);
      }, timeoutMs);
    }),
    child.exited.then(() => false),
  ]);
  clearTimeout(killer);
  const [out, stderr] = await reading;
  const exit: number | null = timedOut ? null : await child.exited;

  const events = out
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const toolUses: ToolUse[] = events
    .filter((e) => e.type === "tool_use" && e.part)
    .map((e) => ({
      tool: e.part.tool,
      status: e.part.state?.status ?? "unknown",
      input: e.part.state?.input,
      output: String(e.part.state?.output ?? ""),
    }));

  return {
    exit,
    events,
    stderr,
    toolUses,
    outputs: (name) => toolUses.filter((t) => t.tool === name).map((t) => t.output),
    text: () =>
      events
        .filter((e) => e.type === "text")
        .map((e) => e.part?.text ?? "")
        .filter((t) => t !== "SMOKE-AUX")
        .join("\n"),
    errors: () => events.filter((e) => e.type === "error"),
  };
}

/** Combined host-visible failure scan: turn exit, error events, stderr. */
export function loadFailure(run: Run): string | undefined {
  if (run.exit !== 0) return `opencode run exited ${run.exit} (timeout kill if null)`;
  const errs = run.errors();
  if (errs.length) return `error events: ${JSON.stringify(errs[0]).slice(0, 300)}`;
  const m = run.stderr.match(LOAD_ERROR_RE);
  if (m) return `stderr load error: ${m[0]}`;
  return undefined;
}

/** Tool names the host offered the model in the last agent request. */
export async function toolsOffered(fake: Fake): Promise<string[]> {
  for (const body of await fake.requests()) {
    if (Array.isArray(body.tools) && body.tools.length)
      return body.tools.map((t: any) => t.function?.name ?? t.name);
  }
  return [];
}

/**
 * Pack this repo and install the tarball with runtime deps only, mirroring
 * how opencode's npm plugin cache installs published packages (devDependencies
 * are NEVER installed there). Returns the installed package directory to use
 * as a plugin path. This is what catches published-artifact breakage that a
 * local-path load cannot.
 */
export async function installPacked(): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "psi-e2e-pack-"));
  // bun's flag is `--destination` (NOT npm's --pack-destination); an unknown
  // flag is silently ignored and the tarball lands in cwd. Create it first:
  // bun 1.4.3 writes nothing, exit 0, when the destination does not exist.
  const packDir = join(work, "packdir");
  mkdirSync(packDir, { recursive: true });
  const pack = Bun.spawnSync(["bun", "pm", "pack", "--destination", packDir], { cwd: REPO });
  if (pack.exitCode !== 0) throw new Error(`bun pm pack failed: ${pack.stderr}`);
  const tgz = readdirTgz(packDir);
  const install = join(work, "install");
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, "package.json"), '{"name":"psi-e2e-consumer","private":true}');
  const npm = Bun.spawnSync(
    ["npm", "install", "--prefix", install, "--omit=dev", "--no-audit", "--no-fund", tgz],
    { cwd: install },
  );
  if (npm.exitCode !== 0) throw new Error(`npm install of packed tarball failed: ${npm.stderr}`);
  return join(install, "node_modules", "opencode-self-improvement");
}

function readdirTgz(dir: string): string {
  const f = readdirSync(dir).find((n) => n.endsWith(".tgz"));
  if (!f) throw new Error("no tarball produced by bun pm pack");
  return join(dir, f);
}

/**
 * Compile the packed TUI entry the way the real host does — with NO tsconfig
 * in scope (opencode's transpiler ignores tsconfig.json inside node_modules),
 * so only a file-local `@jsxImportSource` pragma can steer the JSX runtime.
 * Returns the JSX runtime module specifier present in the compiled output
 * ("" when the build produced none / failed). The v0.6.4 class of release
 * bug = "react/jsx-*".
 */
export function tuiJsxSource(installedDir: string): string {
  rmSync(join(installedDir, "tsconfig.json"), { force: true });
  const scratch = mkdtempSync(join(tmpdir(), "psi-e2e-tui-"));
  const out = join(scratch, "out.js");
  const p = Bun.spawnSync(
    ["bun", "build", join(installedDir, "src", "tui.tsx"), "--target=bun", "--packages=external", "--outfile", out],
    { cwd: scratch },
  );
  if (p.exitCode !== 0) throw new Error(`tui compile failed: ${p.stderr}`);
  const src = readFileSync(out, "utf8");
  rmSync(scratch, { recursive: true, force: true });
  const m = src.match(/["'](react\/jsx[\w-]*|@opentui\/solid\/jsx[\w-]*)["']/);
  return m ? m[1] : "";
}
