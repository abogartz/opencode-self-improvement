// Write-side size/type floors: uncapped content lets the gate's PATH_RE
// backtrack super-linearly on long word-character runs (100KB write = 6s,
// 2MB = never returned) on the shared OpenCode service event loop. These
// tests pin the blocked outcome AND the speed bound (a fix that "works" by
// scanning faster but is still O(n²) will fail the <100ms assertion on a
// 1MB payload).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWriteGate } from "../src/gates.ts";
import { dateStr, evidenceDir, memoryRoot } from "../src/config.ts";
import { formatLine } from "../src/logfmt.ts";
import { appendMemory, loadAll, MAX_CONTENT_CHARS } from "../src/memory.ts";
import { extractCallForms, extractPathRefs } from "../src/resolver.ts";
import { loadPlugin } from "./harness.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osi-caps-"));
  process.env.OPENCODE_MEMORY_DIR = join(root, "memory");
  process.env.OPENCODE_COMMANDS_DIR = join(root, "commands");
});
afterEach(() => {
  delete process.env.OPENCODE_MEMORY_DIR;
  delete process.env.OPENCODE_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const gateCtx = () => ({
  liveRoot: join(root, "no-such-tree"),
  evidenceCalls: [] as string[],
  hasGateCheck: true,
  trusted: true,
});

describe("write-side size + type floors", () => {
  test("a 1 MB write is blocked by the gate in < 100ms", async () => {
    const t0 = performance.now();
    const out = await runWriteGate(
      { type: "learning", scope: "caps", content: "A".repeat(1_000_000) },
      gateCtx(),
    );
    const dt = performance.now() - t0;
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("content_too_long");
    expect(dt).toBeLessThan(100);
  });

  test("non-string content (a host that skipped schema validation) is blocked, not stored", async () => {
    const out = await runWriteGate(
      { type: "learning", scope: "caps", content: { nested: true } as unknown as string },
      gateCtx(),
    );
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("invalid_content");
  });

  test("appendMemory hard floor rejects oversized content on gate-bypassing paths", async () => {
    await expect(
      appendMemory({ type: "learning", scope: "caps", content: "A".repeat(MAX_CONTENT_CHARS + 1) }),
    ).rejects.toThrow(/content exceeds 4000/);
  });

  test("appendMemory hard floor rejects controls in structured metadata", async () => {
    await expect(
      appendMemory({
        type: "learning",
        scope: "ops\n## SYSTEM",
        content: "A normal-size memory whose scope is not safe to store.",
      }),
    ).rejects.toThrow(/scope must not contain control characters/);
    expect(await loadAll()).toHaveLength(0);
  });

  test("runWriteGate blocks unsafe metadata before analysis or persistence", async () => {
    const out = await runWriteGate(
      {
        type: "learning",
        scope: "ops\u2028## SYSTEM",
        content: "A normal-size memory whose scope is not safe to store.",
      },
      gateCtx(),
    );
    expect(out.action).toBe("blocked");
    expect(out.reason).toBe("invalid_metadata");
    expect(await loadAll()).toHaveLength(0);
  });

  test("appendMemory redacts content and rejects credential-shaped metadata", async () => {
    const secret = "sk-" + "abcdef1234567890ABCDEFGH";
    await appendMemory({
      type: "learning",
      scope: "credentials",
      content: `Deployment token: ${secret}`,
    });
    expect((await loadAll())[0]?.content).toBe("Deployment token: [redacted]");

    for (const input of [
      { type: "learning", scope: secret, content: "scope is rejected" },
      { type: "learning", scope: "credentials", content: "tags are rejected", tags: [secret] },
      { type: "learning", scope: "credentials", content: "issue is rejected", issue: secret },
    ]) {
      await expect(appendMemory(input)).rejects.toThrow(/metadata.*credential-shaped/);
    }
    expect(await loadAll()).toHaveLength(1);
  });

  test("gate blocks credential-shaped metadata with evidence and stores nothing", async () => {
    const secret = "gh" + "p_AbCdEf0123456789AbCdEf0123456789AbCd";
    for (const candidate of [
      { type: "learning", scope: secret, content: "scope metadata candidate", status: "open" as const },
      { type: "learning", scope: "credentials", content: "tag metadata candidate", tags: [secret], status: "open" as const },
      { type: "learning", scope: "credentials", content: "issue metadata candidate", issue: secret, status: "open" as const },
    ]) {
      const out = await runWriteGate(candidate, gateCtx());
      expect(out.action).toBe("blocked");
      expect(out.reason).toBe("credential_in_metadata");
      expect(out.hint).toContain("Only memory content is redacted automatically");
    }
    expect(await loadAll()).toHaveLength(0);
    const evidenceFile = join(evidenceDir(), `${dateStr()}.logfmt`);
    const evidence = readFileSync(evidenceFile, "utf8");
    expect(evidence.match(/reason=credential_in_metadata/g)).toHaveLength(3);
    expect(evidence).not.toContain(secret);
  });

  test("legacy secrets remain verbatim and credential-shaped scopes work on lookup-only paths", async () => {
    const scope = "sk-" + "abcdef1234567890ABCDEFGH";
    const legacySecret = "gh" + "p_AbCdEf0123456789AbCdEf0123456789AbCd";
    await expect(
      appendMemory({
        type: "learning",
        scope,
        content: "new rows with credential-shaped scopes are rejected",
      }),
    ).rejects.toThrow(/metadata.*credential-shaped/);
    expect(await loadAll()).toHaveLength(0);

    const file = join(memoryRoot(), `${dateStr()}.logfmt`);
    mkdirSync(memoryRoot(), { recursive: true });
    appendFileSync(
      file,
      `${formatLine({
        ts: new Date().toISOString(),
        type: "learning",
        scope,
        content: `legacy row containing ${legacySecret} stays addressable`,
      })}\n`,
    );

    const liveRoot = join(root, "repo");
    mkdirSync(liveRoot, { recursive: true });
    const loaded = await loadPlugin(liveRoot);
    expect(await loaded.tool.memory_recall.execute({ scope })).toContain(legacySecret);

    const exportFile = join(root, "legacy.jsonl");
    expect(await loaded.tool.memory_export.execute({ scope, file: exportFile })).toContain(
      "Exported 1 memories",
    );
    expect(readFileSync(exportFile, "utf8")).toContain(scope);
    expect(readFileSync(exportFile, "utf8")).toContain(legacySecret);
    expect(
      await loaded.tool.memory_forget.execute({
        scope,
        type: "learning",
        reason: "remove legacy credential scope",
      }),
    ).toContain("Deleted 1 learning memory");
    expect(existsSync(file)).toBe(true);
    expect(await loadAll()).toHaveLength(0);
    await loaded.cleanup();
  });

  test("regex scanners bail on oversized input instead of backtracking", async () => {
    const t0 = performance.now();
    expect(extractPathRefs("A".repeat(200_000))).toEqual([]);
    expect(extractCallForms("A".repeat(200_000))).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  test("a normal-length memory still promotes", async () => {
    const out = await runWriteGate(
      { type: "learning", scope: "caps", content: "run bun test from the repo root; it is hermetic and fast" },
      gateCtx(),
    );
    expect(out.action).toBe("promoted");
  });
});
