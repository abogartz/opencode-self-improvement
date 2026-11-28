import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completionFailure, providerRequest } from "../completion-error.ts";
import type { PiCaptureBinding } from "../pi-family/capture.ts";

/** Freeze model, history and provider routing before yielding to another session. */
export function bindCompletion(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  messages: readonly unknown[],
  configuredModel?: unknown,
): PiCaptureBinding | undefined {
  const registry = ctx.modelRegistry;
  let selected = ctx.model;
  if (typeof configuredModel === "string") {
    const slash = configuredModel.indexOf("/");
    if (slash <= 0 || slash === configuredModel.length - 1) return;
    try {
      selected = registry.find(
        configuredModel.slice(0, slash),
        configuredModel.slice(slash + 1),
      );
    } catch {
      throw completionFailure();
    }
    if (!selected) throw new Error("Pi capture model is unavailable");
  }
  if (!selected) return;
  const model = structuredClone(selected);
  return {
    messages: structuredClone(messages),
    model: { providerID: model.provider, id: model.id },
    async generateText(prompt, signal) {
      signal.throwIfAborted();
      // The host registry retains custom providers and resolves auth at request time.
      const answer = await providerRequest(() =>
        registry
          .streamSimple(
            model,
            {
              messages: [
                { role: "user", content: prompt, timestamp: Date.now() },
              ],
              tools: [],
            },
            {
              signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
              sessionId: `memory-capture:${randomUUID()}`,
              maxTokens: 2048,
            },
          )
          .result(),
      );
      signal.throwIfAborted();
      if (
        answer.stopReason !== "stop" ||
        answer.content.some((part) => part.type === "toolCall")
      )
        throw completionFailure(
          answer.stopReason,
          answer.content.some((part) => part.type === "toolCall"),
        );
      return answer.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    },
  };
}
