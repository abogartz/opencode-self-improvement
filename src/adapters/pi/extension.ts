// Upstream Pi 1.7.0 (@earendil-works/pi-coding-agent), developed with Bun 1.4.4.
// integration/pi pins the SDK and exercises its actual loader and dispatcher.
import type { PiAPI, PiMemoryConfig } from "./runtime.ts";

export function createPiMemory(config: PiMemoryConfig = {}) {
  return async (pi: PiAPI): Promise<void> => {
    if (typeof Bun === "undefined")
      throw new Error(
        "Pi memory requires Bun. Launch Pi's installed CLI with bun instead of node; see README.pi.md.",
      );
    const { installPiMemory } = await import("./runtime.ts");
    await installPiMemory(pi, config);
  };
}

export default createPiMemory();
