import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("viewer exposure warning (#13)", () => {
  test.each([
    { name: "default", allowed: "", host: "127.0.0.1", warns: false },
    { name: "loopback aliases", allowed: " LOCALHOST, 127.0.0.2, ::1, [::1], 0:0:0:0:0:0:0:1, ,", host: "127.0.0.1", warns: false },
    { name: "LAN address", allowed: "192.0.2.10", host: "127.0.0.1", warns: true },
    { name: "external hostname mixed with loopback", allowed: "localhost,viewer.example", host: "127.0.0.1", warns: true },
    { name: "IPv6 non-loopback", allowed: "[2001:db8::1]", host: "127.0.0.1", warns: true },
    { name: "IPv6 zone id", allowed: "fe80::1%en0", host: "127.0.0.1", warns: true },
    { name: "IPv6 encoded zone id", allowed: "fe80::1%25en0", host: "127.0.0.1", warns: true },
    { name: "IPv6 global zone id", allowed: "2001:db8::%eth0", host: "127.0.0.1", warns: true },
    { name: "abbreviated IPv4 warns conservatively", allowed: "127.1", host: "127.0.0.1", warns: true },
    { name: "URL-shaped entry warns conservatively", allowed: "http://127.0.0.1", host: "127.0.0.1", warns: true },
    { name: "localhost lookalike", allowed: "localhost.example", host: "127.0.0.1", warns: true },
    { name: "wildcard bind without extra hosts", allowed: "", host: "0.0.0.0", warns: true },
  ])("$name", ({ allowed, host, warns }) => {
    const root = mkdtempSync(join(tmpdir(), "osi-viewer-startup-"));
    try {
      // A fresh process reads the startup env, starts a real server, then stops
      // it after an actual HTTP request. Capture stderr rather than replacing console.warn.
      const result = Bun.spawnSync([
        process.execPath, "--eval",
        'import { startViewer } from "./src/viewer/server.ts"; const viewer = await startViewer(0); try { const response = await fetch("http://127.0.0.1:" + viewer.server.port + "/"); if (response.status !== 200) throw new Error("viewer HTTP status " + response.status); await response.text(); } finally { viewer.server.stop(true); }',
      ], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          OPENCODE_MEMORY_DIR: join(root, "memory"),
          OPENCODE_COMMANDS_DIR: join(root, "commands"),
          OPENCODE_VIEWER_HOST: host,
          OPENCODE_VIEWER_ALLOWED_HOSTS: allowed,
        },
        stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr).toBe(0);
      expect(stderr.includes("[memory-viewer] WARNING:")).toBe(warns);
      if (warns) {
        expect(stderr.match(/\[memory-viewer\] WARNING:/g)).toHaveLength(1);
        expect(stderr).toContain("plain HTTP without authentication");
        expect(stderr).toContain("read or modify the store");
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
