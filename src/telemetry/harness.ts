import { AsyncLocalStorage } from "node:async_hooks";

const current = new AsyncLocalStorage<string>();

export function harnessName(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(value)
    ? value
    : "unknown";
}

/** Old telemetry predates other adapters; new unbound operations stamp unknown. */
export function recordedHarness(value: unknown): string {
  return value === undefined ? "opencode" : harnessName(value);
}

export function currentHarness(): string {
  return current.getStore() ?? "unknown";
}

/** Async operations retain their source even when another host runs concurrently. */
export function withHarness<T>(harness: string, run: () => T): T {
  return current.run(harnessName(harness), run);
}
