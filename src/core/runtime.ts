// Bun version floor. The plugin runs inside opencode, whose v2 compiled
// binaries embed Bun (upstream builds with BUN_COMPILE_RELEASE=bun-v1.4.4;
// older v2 builds embed older bun). The store code's filesystem calls have
// version-divergent failure modes — e.g. DirHandle.close() behaves differently
// on some Bun+Windows combos — so an old host shows up as odd memory errors,
// not as a clean "unsupported" signal. MIN_BUN is the lower bound of the Bun
// versions this repo has actually been run against: 1.3.10 and 1.4.4. Pure
// module: nothing here reads the environment; the caller (src/index.ts)
// injects the version string, so these helpers are unit-testable anywhere.

export const MIN_BUN: readonly [number, number, number] = [1, 3, 0];

// Pulls the first x.y.z triple out of a version string: "1.4.4",
// "v1.4.4-canary" and "bun-v1.4.4" all parse; junk or a partial version
// (no patch component) yields null. Never throws.
export function parseBunVersion(raw: string): [number, number, number] | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Numeric (not lexical) triple compare: 1.10.0 > 1.3.0.
function cmpTriples(a: readonly number[], b: readonly number[]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// One-line startup warning when the host's Bun is below MIN_BUN or its version
// could not be parsed; null when the version looks fine. Warn-only by design:
// an old embedded bun should be visible, but must not stop memory from
// loading. The caller decides how often to emit it (src/index.ts: once).
export function bunFloorWarning(versionString: string | undefined): string | null {
  const floor = MIN_BUN.join(".");
  const seen = typeof versionString === "string" ? parseBunVersion(versionString) : null;
  if (seen) {
    if (cmpTriples(seen, MIN_BUN) >= 0) return null;
    return `[opencode-self-improvement] Bun ${seen.join(".")} is below the supported minimum ${floor}; memory features may misbehave.`;
  }
  const shown = versionString === undefined ? "unknown" : JSON.stringify(versionString);
  return `[opencode-self-improvement] Bun version ${shown} is unrecognized (supported minimum ${floor}); memory features may misbehave.`;
}
