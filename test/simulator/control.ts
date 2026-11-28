export interface TraceEntry {
  sequence: number;
  host: string;
  event: string;
  detail?: unknown;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class Trace {
  private log: TraceEntry[] = [];
  get entries(): readonly TraceEntry[] {
    return copy(this.log);
  }
  add(host: string, event: string, detail?: unknown): void {
    let snapshot: unknown;
    try {
      snapshot = copy(detail);
    } catch {
      try {
        snapshot = JSON.parse(
          JSON.stringify(detail, (_key, value) =>
            typeof value === "function"
              ? "[callback]"
              : typeof value === "bigint"
                ? String(value)
                : value,
          ),
        );
      } catch {
        snapshot = "[unserializable input]";
      }
    }
    this.log.push({
      sequence: this.log.length + 1,
      host,
      event,
      detail: snapshot,
    });
  }
  format(): string {
    return this.log
      .slice(-100)
      .map(
        (e) =>
          `${e.sequence} ${e.host} ${e.event} ${JSON.stringify(e.detail) ?? ""}`,
      )
      .join("\n");
  }
}

/** Time limits diagnose a missing checkpoint; they never advance the scenario. */
export async function checkpoint<T>(
  label: string,
  promise: Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Checkpoint timed out: ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ControlledCall<I, O> {
  readonly calls: I[] = [];
  private plans: Array<{ enter(input: I): Promise<O>; cancel(): void }> = [];
  private pending = new Set<{ cancel(): void }>();
  private stopped = false;
  private trace: Trace;
  private host: string;
  private name: string;
  private fallback: (input: I) => O | Promise<O>;
  constructor(
    trace: Trace,
    host: string,
    name: string,
    fallback: (input: I) => O | Promise<O>,
  ) {
    this.trace = trace;
    this.host = host;
    this.name = name;
    this.fallback = fallback;
  }

  pause(label: string) {
    if (this.stopped) throw new Error(`${this.name} is closed`);
    const arrived = Promise.withResolvers<I>();
    const response = Promise.withResolvers<O>();
    // Plans may be rejected or cancelled before any consumer reaches them.
    void response.promise.catch(() => {});
    void arrived.promise.catch(() => {});
    const plan = {
      enter: async (input: I) => {
        this.trace.add(this.host, `${this.name}.paused`, { label });
        arrived.resolve(copy(input));
        return response.promise;
      },
      cancel: () => {
        const error = new Error(`Scenario closed: ${this.name}/${label}`);
        arrived.reject(error);
        response.reject(error);
      },
    };
    this.plans.push(plan);
    this.pending.add(plan);
    return {
      get entered() {
        return checkpoint(label, arrived.promise);
      },
      resolve: (value: O) => {
        this.trace.add(this.host, `${this.name}.release`, { label });
        response.resolve(value);
      },
      reject: (error: Error) => {
        this.trace.add(this.host, `${this.name}.reject`, {
          label,
          error: error.message,
        });
        response.reject(error);
      },
    };
  }
  reply(value: O): void {
    this.pause("scripted reply").resolve(value);
  }
  fail(error: Error): void {
    this.pause("scripted failure").reject(error);
  }
  async call(input: I): Promise<O> {
    if (this.stopped) throw new Error(`${this.name} is closed`);
    this.calls.push(copy(input));
    this.trace.add(this.host, `${this.name}.called`, input);
    const plan = this.plans.shift();
    try {
      const result = await (plan ? plan.enter(input) : this.fallback(input));
      this.trace.add(this.host, `${this.name}.returned`, result);
      return result;
    } catch (error) {
      this.trace.add(this.host, `${this.name}.failed`, String(error));
      throw error;
    } finally {
      if (plan) this.pending.delete(plan);
    }
  }
  close(): void {
    this.stopped = true;
    for (const plan of this.pending) plan.cancel();
    this.pending.clear();
    this.plans = [];
  }
}
