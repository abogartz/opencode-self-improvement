import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryRoot } from "../../core/config/paths.ts";

export function memoryOptions(
  overrides: Record<string, unknown> = {},
  host = { name: "oh-my-pi", configEnv: "OMP_MEMORY_CONFIG" },
): Record<string, unknown> {
  const explicit = process.env[host.configEnv];
  const file = explicit || join(memoryRoot(), `${host.name}.json`);
  let text = "{}";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (explicit || (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Cannot read ${host.name} memory configuration: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid JSON in ${host.name} memory configuration: ${file}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(
      `${host.name} memory configuration must be an options object: ${file}`,
    );
  const options = { ...parsed, ...overrides } as Record<string, unknown>;
  for (const key of [
    "autoCapture",
    "captureOnCompact",
    "captureGuidedRules",
    "captureDelta",
    "captureOnSignal",
    "contradictionSurface",
    "notifyBlocked",
  ]) {
    if (options[key] !== undefined && typeof options[key] !== "boolean")
      throw new Error(`${host.name} memory option ${key} must be boolean`);
  }
  return options;
}
