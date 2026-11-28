import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryRoot } from "../../core/config/paths.ts";

export function memoryOptions(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const explicit = process.env.OMP_MEMORY_CONFIG;
  const file = explicit || join(memoryRoot(), "oh-my-pi.json");
  let text = "{}";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (explicit || (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`Cannot read oh-my-pi memory configuration: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in oh-my-pi memory configuration: ${file}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(
      `oh-my-pi memory configuration must be an options object: ${file}`,
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
      throw new Error(`oh-my-pi memory option ${key} must be boolean`);
  }
  return options;
}
