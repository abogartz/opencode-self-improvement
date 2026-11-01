// Probe for #143: memory_export must export what the caller can READ and
// nothing else. Every other read path made all-repository breadth a property of
// the entry point in #133; the export path still dumped every repo's private
// rows into a plaintext JSONL. The export twin of #127.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin, type LoadedPlugin } from "./harness.ts";
import { appendMemory } from "../src/store/files/append.ts";
import { exportMemories } from "../src/portable/export.ts";
import { rememberSessionDir, resetSessionScopes, resolveRepo, setRepoScope } from "../src/identity/repokey.ts";
import { resetState } from "../src/core/state.ts";

let root: string;
let a: string;
let b: string;
let plugins: LoadedPlugin[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-exp-"));
  a = join(root, "repo-a");
  b = join(root, "repo-b");
  mkdirSync(a);
  mkdirSync(b);
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  plugins = [];
});

afterEach(async () => {
  setSystemTime();
  for (const p of plugins) await p.cleanup();
  resetState();
  resetSessionScopes();
  setRepoScope(null);
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const A_MARK = "A_PRIVATE_BUILD_NOTE_stays_in_alpha";
const B_MARK = "B_PRIVATE_DEPLOY_SECRET_never_reaches_alpha";
const G_MARK = "GLOBAL_SHARED_CONVENTION_visible_to_everyone";

async function plugin(dir: string | null) {
  const p = await loadPlugin(dir);
  plugins.push(p);
  return p;
}
function seed(dir: string, content: string) {
  const scope = resolveRepo(dir);
  return appendMemory({ type: "context", scope: "s", content, repo: scope.key, repoPath: scope.path });
}
const ctx = (sessionID: string) => ({ sessionID, id: "exp-proof" });
function exportedText(result: { content: string }): string {
  const path = result.content.split(" -> ").pop()!;
  return readFileSync(path, "utf8");
}

describe("memory_export respects repo visibility (#143)", () => {
  test("an export run by repo A's session omits repo B's private rows", async () => {
    const pa = await plugin(a);
    await plugin(b);
    rememberSessionDir("ses-a", a);
    await seed(a, A_MARK);
    await seed(b, B_MARK);
    // Unstamped = legacy = global visibility, the one breadth every session
    // sees — seeded with NO module scope in play, or the last setup's repo
    // would own the stamp (#152's exact quirk; see undo-ownership for why
    // seeds inside plugin sessions carry explicit stamps instead).
    setRepoScope(null);
    await appendMemory({ type: "context", scope: "s", content: G_MARK });
    // Control: recall already hides B from this session — export is the only
    // path deviating from the reader every other entry point gets.
    const recall = await pa.tools.memory_recall.execute({ query: B_MARK }, ctx("ses-a"));
    expect(recall.content).not.toContain(B_MARK);
    const res = await pa.tools.memory_export.execute({}, ctx("ses-a"));
    expect(res.content).toContain("Exported");
    const text = exportedText(res);
    expect(text).toContain(A_MARK);
    expect(text).toContain(G_MARK);
    expect(text).not.toContain(B_MARK);
  });

  test("session-less (viewer/CLI-shaped) callers keep full breadth — the entry-point property", async () => {
    // No plugin loads here: no module scope exists, so the ambient reader
    // resolves exactly as the standalone viewer's and CLI maintenance callers'
    // does — all repositories.
    await seed(a, A_MARK);
    await seed(b, B_MARK);
    await appendMemory({ type: "context", scope: "s", content: G_MARK });
    const res = await exportMemories({});
    const text = readFileSync(res.path, "utf8");
    expect(text).toContain(A_MARK);
    expect(text).toContain(B_MARK);
    expect(text).toContain(G_MARK);
    // The header still vouches for the file on import (#24's contract).
    expect(text.split("\n")[0]).toContain("_export");
  });

  test("an unbound session's export carries no foreign rows (fail-closed)", async () => {
    const pa = await plugin(a);
    await plugin(b);
    await seed(a, A_MARK);
    await seed(b, B_MARK);
    const res = await pa.tools.memory_export.execute({}, ctx("ses-never-seen"));
    expect(res.content).toContain("Exported");
    // Whether A's own rows ride along is the binding's business (#127's
    // provisional rule); the security property is that B's NEVER do.
    expect(exportedText(res)).not.toContain(B_MARK);
  });

  test("two sessions exporting in the same second keep separate artifacts", async () => {
    // Review finding on #156: default destinations were second-granularity
    // timestamps opened with O_TRUNC, so B's export silently REPLACED A's
    // file — and reading A's own returned path then yielded B's private
    // rows. The scoping fix leaks through the name. Millisecond stamps
    // still collide; the default name must be unique, and its creation
    // exclusive.
    const pa = await plugin(a);
    const pb = await plugin(b);
    rememberSessionDir("ses-a", a);
    rememberSessionDir("ses-b", b);
    await seed(a, A_MARK);
    await seed(b, B_MARK);
    // Same-second calls are ordinary (a shared tick, a scripted batch); the
    // frozen clock only guarantees the timing — the exports are real.
    setSystemTime(new Date("2026-10-28T12:34:56.100Z"));
    const outA = await pa.tools.memory_export.execute({}, ctx("ses-a"));
    expect(outA.content).toContain("Exported");
    const pathA = outA.content.split(" -> ").pop()!;
    expect(readFileSync(pathA, "utf8")).toContain(A_MARK);
    const outB = await pb.tools.memory_export.execute({}, ctx("ses-b"));
    expect(outB.content).toContain("Exported");
    expect(outB.content.split(" -> ").pop()).not.toBe(pathA);
    // A's returned path is A's artifact: never another repo's content.
    expect(readFileSync(pathA, "utf8")).not.toContain(B_MARK);
  });
});
