import type { MemoryToolHost } from "./contracts.ts";
import type { MemoryLifecycleHost } from "./lifecycle.ts";
import type { MemoryCaptureHost } from "./capture.ts";
import type { HostCapabilities } from "./capabilities.ts";

/** The ports needed to assemble the shared memory engine in one host instance. */
export interface MemoryHost {
  /** Stable adapter identifier for telemetry; never a memory ownership boundary. */
  harness?: string;
  /** Capture availability is derived from its optional methods at inspection time. */
  readonly capabilities: Omit<HostCapabilities, "capture">;
  tools: MemoryToolHost;
  lifecycle: MemoryLifecycleHost;
  capture: MemoryCaptureHost;
  /** Optional host-native command setup, completed before tool registration. */
  installCommands?(): Promise<void>;
}

export interface MemorySetupOptions {
  directory?: string;
  options?: Record<string, unknown>;
}

export interface MemoryRuntime {
  /** Inspect the adapter's guarantees; availability does not prove delivery. */
  readonly capabilities: HostCapabilities;
  /** Stops lifecycle/capture admission synchronously; repeated calls share cleanup. */
  dispose(): Promise<void>;
}
