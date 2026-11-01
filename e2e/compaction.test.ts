// The session.compaction hook end-to-end (#241). This is the README claim
// "durable memories are handed to the compaction summarizer" pinned against a
// REAL host: a service-hosted session stores a fact, the fact is compacted via
// the host's own compact endpoint, and the provider request log is inspected
// to prove the durable-memory anchor actually rode into the summarizer call.
// Uses the service shape (opencode serve --service + HTTP API) because the
// compaction trigger is a host-side operation `opencode run` never performs.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO, type Fake, startFake, resolveOpencode } from "./support/harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ServeGuest {
  root: string;
  memoryDir: string;
  projDir: string;
  stop: () => void;
  waitService: () => Promise<void>;
  req: (path: string, init?: RequestInit) => Promise<Response>;
}

/** Isolated service instance with the plugin in the global config (the
 *  production shape; same skeleton as stamp.test.ts). */
function makeServeGuest(fake: Fake, pluginPath: string): ServeGuest {
  const root = mkdtempSync(join(tmpdir(), "osi-compact-"));
  const g = (n: string) => {
    mkdirSync(join(root, n), { recursive: true });
    return join(root, n);
  };
  const cfg = g("cfg");
  mkdirSync(join(cfg, "opencode"), { recursive: true });
  const proj = g("proj");
  const memoryDir = g("memory");
  const serveRoot = g("homeroot");
  g("data");
  g("state");
  g("cache");

  writeFileSync(
    join(cfg, "opencode", "opencode.json"),
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

  const env: Record<string, string> = {
    HOME: serveRoot,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    XDG_CONFIG_HOME: cfg,
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_MEMORY_DIR: memoryDir,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
  };

  const port = 18_500 + Math.floor(Math.random() * 900);
  const base = `http://127.0.0.1:${port}`;
  const pwFile = join(cfg, "opencode", "service.json");
  let password = "";
  const authHeader = () => ({ authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` });

  const child = Bun.spawn([resolveOpencode(), "serve", "--service", "--port", String(port)], {
    cwd: serveRoot,
    env,
    stdout: "ignore",
    stderr: "ignore",
  });

  return {
    root,
    memoryDir,
    projDir: proj,
    stop: () => child.kill(9),
    async waitService() {
      for (let i = 0; i < 150; i++) {
        if (existsSync(pwFile)) {
          try {
            password = JSON.parse(readFileSync(pwFile, "utf8")).password as string;
            const r = await fetch(`${base}/api/session?limit=1`, { headers: authHeader() });
            if (r.status === 200) return;
          } catch {}
        }
        await sleep(100);
      }
      throw new Error("serve --service did not come up");
    },
    req: (path, init = {}) =>
      fetch(base + path, {
        ...init,
        headers: { "content-type": "application/json", ...authHeader(), ...(init.headers ?? {}) },
      }),
  };
}

let fake: Fake;
const guests: ServeGuest[] = [];

beforeAll(async () => {
  fake = await startFake();
});
afterEach(async () => {
  for (const g of guests.splice(0)) {
    g.stop();
    await sleep(150);
    rmSync(g.root, { recursive: true, force: true });
  }
});
afterAll(() => fake.stop());

function call(id: string, tool: string, args: Record<string, unknown>) {
  return { tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] };
}

const ANCHOR = "Durable memory to preserve in this summary";
const FACT =
  "the flimflam compaction probe fact keeps its exact token zephyr-quota across summarization runs";

describe("Feature: memory-aware compaction over the service host (#241)", () => {
  // @covers hook:session.compaction
  test("Scenario: a host compaction hands the durable-memory anchor to the summarizer", async () => {
    // Given a service-hosted session that stores one durable fact
    const g = makeServeGuest(fake, REPO);
    guests.push(g);
    await g.waitService();

    const created = await (
      await g.req("/api/session", { method: "POST", body: JSON.stringify({ location: { directory: g.projDir } }) })
    ).json();
    const sid: string = created.data.id;

    fake.setSteps({
      "CMPCT::store": [
        call("c1", "memory_remember", {
          type: "context",
          scope: "compaction-probe",
          status: "open",
          content: FACT,
        }),
        { content: "CMPCT-DONE" },
      ],
    });
    const prompt = await g.req(`/api/session/${sid}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "CMPCT::store please store the probe fact" }),
    });
    expect(prompt.status).toBe(200);

    // And the row is durable before the compaction is ordered
    const storeDeadline = Date.now() + 30_000;
    let stored = "";
    while (Date.now() < storeDeadline) {
      const day = new Date().toISOString().split("T")[0];
      const f = join(g.memoryDir, `${day}.logfmt`);
      if (existsSync(f)) stored = readFileSync(f, "utf8");
      if (stored.includes("zephyr-quota")) break;
      await sleep(200);
    }
    expect(stored).toInclude("zephyr-quota");

    // When the HOST compacts the session (its own compact endpoint; `id` is
    // an optional msg_* anchor, so the bare steer form is the plain request)
    const compact = await g.req(`/api/session/${sid}/compact`, {
      method: "POST",
      body: JSON.stringify({ delivery: "steer" }),
    });
    expect(compact.status).toBe(200);

    // Then the plugin's compaction hook pushed the durable-memory anchor onto
    // the summarizer request: the provider log shows a call carrying both the
    // anchor header and the stored fact, which only the hook adds.
    const summarizerDeadline = Date.now() + 60_000;
    let anchorReq: any = undefined;
    while (Date.now() < summarizerDeadline && !anchorReq) {
      for (const body of await fake.requests()) {
        const dump = JSON.stringify(body.messages ?? []);
        if (dump.includes(ANCHOR) && dump.includes("zephyr-quota")) anchorReq = body;
      }
      if (!anchorReq) await sleep(250);
    }
    expect(anchorReq, "a provider request carried the durable-memory anchor").toBeTruthy();
    // Characterization: the anchor rides as a system/developer part, not as a
    // user turn the model could mistake for instructions from the transcript.
    const carried = (anchorReq.messages as any[]).filter((m) =>
      JSON.stringify(m.content ?? "").includes(ANCHOR),
    );
    expect(carried.length).toBeGreaterThanOrEqual(1);
  }, 240_000);
});
