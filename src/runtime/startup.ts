import type { MemoryCaptureHost } from "../host/capture.ts";
import { fileURLToPath } from "node:url";
import { guarded } from "../core/hooks.ts";
import { injectBudget } from "../core/config/budgets.ts";
import { loadAll } from "../store/files/load.ts";
import { record } from "../telemetry/record.ts";
import { parseModelRef } from "../capture/candidates.ts";

/** Report configured capture state without coupling it to a host's API shape. */
export async function recordStartup(
  capture: MemoryCaptureHost,
  options: Record<string, unknown>,
): Promise<void> {
  await guarded("plugin_load heartbeat", async () => {
    let pluginVersion = "unknown";
    // Which COPY of this plugin the host actually loaded. Version alone could
    // not answer it: a checkout and the published package it came from share
    // a version, and the npm cache has held a stale one while a session ran
    // against something else entirely. The heartbeat now names the directory,
    // so "is my change live?" is one grep instead of an afternoon.
    let entryDir = "unknown";
    try {
      const pkg = await Bun.file(
        new URL("../../package.json", import.meta.url),
      ).json();
      if (typeof pkg?.version === "string") pluginVersion = pkg.version;
    } catch {
      // a heartbeat with an unknown version still beats no heartbeat
    }
    try {
      entryDir = fileURLToPath(new URL("../../", import.meta.url));
    } catch {
      // same: the version line is still worth emitting
    }
    // Auto-capture is armed unless the config opts it out: an absent key
    // means on, so the switch is read as a negative opt-out.
    const wantCapture = options.autoCapture !== false;
    // an omitted captureModel is a valid arm — the capture inherits
    // the session's model (session.context) or the host default. Only an
    // explicit but malformed string is invalid_model.
    const captureModelOpt = options.captureModel;
    const modelOk =
      captureModelOpt === undefined || !!parseModelRef(captureModelOpt);
    const keys = ["turnEndEvents", "generateText", "readTranscript"] as const;
    const capabilities = keys
      .filter((key) => typeof capture[key] === "function")
      .map((key) => capture.capabilityLabels?.[key] ?? key);
    const captureState = !wantCapture
      ? // captureOnCompact alone is a distinct misconfiguration (the
        // runtime warns about it and stays disabled) — name it, or "off
        // (default)" and "wrong switch set" share one line.
        options.captureOnCompact === true
        ? "switch_mismatch"
        : "off"
      : !modelOk
        ? "invalid_model"
        : capabilities.length < 3
          ? "no_capabilities"
          : "on";
    await record(
      "plugin_load",
      {
        version: pluginVersion,
        entry: entryDir,
        capture: captureState,
        capture_on_compact: options.captureOnCompact !== false,
        capabilities: `[${capabilities.join(",")}]`,
        subscribed: `[${capture.subscribedEvents.join(",")}]`,
        inject_budget: injectBudget(),
        store_rows: (await loadAll()).length,
      },
      false,
    );
  });
}
