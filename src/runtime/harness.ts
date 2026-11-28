import type { MemoryHost } from "../host/runtime.ts";
import type { LifecycleHandlers } from "../host/lifecycle.ts";
import { harnessName, withHarness } from "../telemetry/harness.ts";

/** Bind telemetry at callback entry, not through mutable process-wide identity. */
export function attributedHost(host: MemoryHost): MemoryHost {
  const harness = harnessName(host.harness);
  return {
    harness,
    get capabilities() {
      return host.capabilities;
    },
    tools: {
      directories: host.tools.directories,
      registerTools: (register) =>
        host.tools.registerTools((editor) =>
          register({
            add(tool) {
              editor.add({
                ...tool,
                execute: (args, context) =>
                  withHarness(harness, () => tool.execute(args, context)),
              });
            },
          }),
        ),
    },
    lifecycle: {
      register: (handlers) =>
        host.lifecycle.register(
          Object.fromEntries(
            Object.entries(handlers).map(([name, handler]) => [
              name,
              (event: never) => withHarness(harness, () => handler(event)),
            ]),
          ) as unknown as LifecycleHandlers,
        ),
    },
    // Some hosts attach capabilities while tools/hooks are registered.
    get capture() {
      return host.capture;
    },
    installCommands: host.installCommands
      ? () => host.installCommands!()
      : undefined,
  };
}
