import { resetCaptureCooldowns } from "../../src/runtime/capture.ts";
import { resetCaptureCursors } from "../../src/capture/policy.ts";
import { Trace, checkpoint } from "./control.ts";
import { TestHost, type HostOptions } from "./host.ts";

export class Scenario {
  readonly trace = new Trace();
  private closed = false;
  private hosts = new Map<string, TestHost>();
  host(name: string, options?: HostOptions): TestHost {
    if (this.closed) throw new Error("Scenario is closed");
    if (this.hosts.has(name))
      throw new Error(`Duplicate scenario host: ${name}`);
    const host = new TestHost(name, options, this.trace);
    this.hosts.set(name, host);
    return host;
  }
  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.hosts.values()].map((h) => h.close()),
    );
    const errors = results.flatMap((r) =>
      r.status === "rejected" ? [r.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Scenario cleanup failed");
  }
}

/** Run sequentially within a test process: the real engine has process-wide state. */
export async function runScenario(
  name: string,
  run: (scenario: Scenario) => Promise<void>,
  timeoutMs = 10_000,
): Promise<void> {
  resetCaptureCooldowns();
  resetCaptureCursors();
  const scenario = new Scenario();
  const failures: unknown[] = [];
  try {
    await checkpoint(name, run(scenario), timeoutMs);
  } catch (error) {
    failures.push(error);
  }
  try {
    await scenario.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new Error(
      `Scenario: ${name}\n${failures.map(String).join("\n")}\nTrace:\n${scenario.trace.format()}`,
      { cause: new AggregateError(failures) },
    );
}
