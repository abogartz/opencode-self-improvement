// #395 probe: records what `ctx.generate.text` actually resolves to inside a
// plugin process, when the provider DID report usage. The fake model attaches
// `usage` to every final chunk (see ../fake-model.ts); whatever the host hands
// the plugin is the host's contract, and this file is what observes it.
// Written as a standalone package (the host loads plugins by package, not by
// bare file) so nothing from src/ can colour the shape. The hook is
// `session.context` — the same seam the real plugin injects through, and the
// first one that fires on `opencode run`.
import { writeFileSync } from "node:fs";

// The generate call the test correlates against: e2e/generate-receipt.test.ts
// finds this text in the fake model's request log to prove the call reached
// the provider, and in its served log to prove the answer carried a receipt.
const PROBE_PROMPT = "probe receipt";

/**
 * The subset of the host context this probe touches, declared locally on
 * purpose. Importing the SDK's (or src/core/host.ts's) context type would let
 * a DECLARED shape hide the runtime shape the probe exists to observe, and
 * would tie a standalone package to the repo it watches from outside.
 */
interface GenerateResult {
  text?: unknown;
  usage?: unknown;
  [key: string]: unknown;
}

interface ProbeContext {
  generate: {
    text: (input: {
      model: { providerID: string; id: string };
      prompt: string;
    }) => Promise<GenerateResult | string>;
  };
  session?: {
    hook: (name: string, cb: () => Promise<undefined>) => Promise<unknown>;
  };
}

export default {
  id: "probe-receipt",
  setup: async (ctx: ProbeContext) => {
    const out = process.env.PROBE_OUT;
    if (!out) return;
    await ctx.session?.hook("context", async () => {
      try {
        const res = await ctx.generate.text({
          model: { providerID: "fake", id: "scripted" },
          prompt: PROBE_PROMPT,
        });
        const result = res && typeof res === "object" ? res : undefined;
        writeFileSync(
          out,
          JSON.stringify({
            generateKeys: Object.keys(ctx.generate ?? {}),
            resultKeys: result ? Object.keys(result) : null,
            resultType: typeof res,
            usage: result?.usage ?? null,
            textType: typeof result?.text,
          }),
        );
      } catch (err) {
        writeFileSync(
          out,
          JSON.stringify({ error: String((err as Error)?.message ?? err) }),
        );
      }
      return undefined;
    });
  },
};
