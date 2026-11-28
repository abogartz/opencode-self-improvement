import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CaptureTranscript,
  MemoryCaptureHost,
} from "../../host/capture.ts";
import type { SessionModelRef } from "../../capture/session-model.ts";
import { decodeTranscript } from "./transcript.ts";

/** The caller binds the host's model and credentials synchronously at turn end. */
export interface OmpCaptureBinding {
  messages: readonly unknown[];
  model: SessionModelRef;
  generateText(prompt: string, signal: AbortSignal): Promise<string>;
}
interface Snapshot {
  sessionID: string;
  transcript: CaptureTranscript;
  model: SessionModelRef;
  generateText: OmpCaptureBinding["generateText"];
  done: ReturnType<typeof Promise.withResolvers<void>>;
}

export function createOhMyPiCapture() {
  const scoped = new AsyncLocalStorage<Omit<Snapshot, "done">>();
  const queue: Snapshot[] = [];
  const compactions = new Set<Promise<void>>();
  let active: Snapshot | undefined;
  let wake = Promise.withResolvers<void>();
  let closed = false;
  let subscribed = false;
  const current = () => scoped.getStore() ?? active;
  const close = () => {
    closed = true;
    active?.done.resolve();
    for (const item of queue.splice(0)) item.done.resolve();
    wake.resolve();
  };
  const host: MemoryCaptureHost = {
    subscribedEvents: ["agent_end"],
    capabilityLabels: {
      turnEndEvents: "agent_end",
      readTranscript: "snapshot",
      generateText: "bound completion",
    },
    async *turnEndEvents(signal) {
      subscribed = true;
      signal.addEventListener("abort", close, { once: true });
      try {
        while (!closed && !signal.aborted) {
          if (!queue.length) {
            await wake.promise;
            wake = Promise.withResolvers<void>();
            continue;
          }
          active = queue.shift()!;
          try {
            yield { sessionID: active.sessionID };
          } finally {
            active.done.resolve();
            active = undefined;
          }
        }
      } finally {
        signal.removeEventListener("abort", close);
        close();
      }
    },
    readTranscript: async (sid) => {
      const snapshot = current();
      return snapshot?.sessionID === sid ? snapshot.transcript : undefined;
    },
    defaultModel: (sid) => {
      const snapshot = current();
      return snapshot && snapshot.sessionID === sid
        ? { ...snapshot.model }
        : null;
    },
    async generateText({ sessionID, model, prompt, signal }) {
      signal.throwIfAborted();
      const snapshot = current();
      if (!snapshot || snapshot.sessionID !== sessionID)
        throw new Error("oh-my-pi capture snapshot is unavailable");
      if (
        model.providerID !== snapshot.model.providerID ||
        model.id !== snapshot.model.id
      )
        throw new Error(
          "oh-my-pi capture model does not match the bound session model",
        );
      return snapshot.generateText(prompt, signal);
    },
  };
  return {
    host,
    close,
    track(work: Promise<void>): void {
      compactions.add(work);
      work.then(
        () => compactions.delete(work),
        () => compactions.delete(work),
      );
    },
    withBinding<T>(
      sessionID: string,
      binding: OmpCaptureBinding,
      run: (transcript: CaptureTranscript) => T,
    ): T {
      const transcript = decodeTranscript(binding.messages);
      return scoped.run(
        {
          sessionID,
          transcript,
          model: { ...binding.model },
          generateText: binding.generateText,
        },
        () => run(transcript),
      );
    },
    async settle(timeoutMs: number): Promise<void> {
      const pending = [
        ...[...(active ? [active] : []), ...queue].map(
          (item) => item.done.promise,
        ),
        ...compactions,
      ];
      if (!pending.length) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    publish(sessionID: string, binding: OmpCaptureBinding): Promise<void> {
      // Invalid capture configuration may never subscribe. Host callbacks must
      // still finish, including events arriving during partial initialization.
      if (closed || !subscribed) return Promise.resolve();
      // Coalesce repeated notifications while retaining the first snapshot.
      const existing =
        active?.sessionID === sessionID
          ? active
          : queue.find((item) => item.sessionID === sessionID);
      if (existing) return existing.done.promise;
      // Backpressure is bounded even for a host dispatching callbacks concurrently.
      if (queue.length >= 64) return Promise.resolve();
      const item: Snapshot = {
        sessionID,
        transcript: decodeTranscript(binding.messages),
        model: { ...binding.model },
        generateText: binding.generateText,
        done: Promise.withResolvers<void>(),
      };
      queue.push(item);
      wake.resolve();
      return item.done.promise;
    },
  };
}
