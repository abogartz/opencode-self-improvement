import { randomUUID } from "node:crypto";
import { completionFailure, providerRequest } from "../completion-error.ts";
import type { OmpContext } from "./context.ts";
import type { OmpCaptureBinding } from "./capture.ts";

/** Bind routing and transcript before any asynchronous usage or model work. */
export function bindCompletion(
  ctx: OmpContext,
  messages: readonly unknown[],
  configuredModel?: unknown,
): OmpCaptureBinding | undefined {
  const registry = ctx.modelRegistry;
  if (!registry) return;
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
    if (!selected) throw new Error("oh-my-pi capture model is unavailable");
  }
  if (!selected) return;
  const model = structuredClone(selected);
  let apiKey: ReturnType<typeof registry.resolver>;
  try {
    apiKey = registry.resolver(model, ctx.sessionManager.getSessionId());
  } catch {
    throw completionFailure();
  }
  return {
    messages: structuredClone(messages),
    model: { providerID: model.provider, id: model.id },
    async generateText(prompt, signal) {
      // The extension loader resolves this to the running host's SDK instance.
      const { completeSimple } = await import("@oh-my-pi/pi-ai");
      signal.throwIfAborted();
      const answer = await providerRequest(() =>
        completeSimple(
          model,
          {
            messages: [
              { role: "user", content: prompt, timestamp: Date.now() },
            ],
            tools: [],
          },
          {
            apiKey,
            signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
            sessionId: `memory-capture:${randomUUID()}`,
            maxTokens: 2048,
          },
        ),
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
