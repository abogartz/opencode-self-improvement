// Keep a real SDK session alive until its terminal extension callback settles.
import { join } from "node:path";
import type {
  ExtensionContext,
  ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import type { OmpAPI, OmpEvents } from "../../src/adapters/oh-my-pi/context.ts";
import captureExtension from "./capture-extension.ts";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, _extensionPath, prompt] = process.argv.slice(2);
const finished = Promise.withResolvers<void>();
const probe: ExtensionFactory = async (pi) => {
  const host: OmpAPI<ExtensionContext> = pi;
  const on: OmpAPI<ExtensionContext>["on"] = (name, handler) => {
    host.on(name, async (event, ctx) => {
      const result = await handler(event, ctx);
      if (name === "agent_end") {
        const ended = event as OmpEvents["agent_end"];
        if (!ended.willContinue && !ended.awaitingAsyncWork) finished.resolve();
      }
      return result;
    });
  };
  await captureExtension({ on, registerTool: (tool) => pi.registerTool(tool) });
};
const { session } = await openSession(cwd, agentDir, baseUrl, {
  extensions: [probe],
});
try {
  await session.prompt(prompt);
  // SDK prompt()/waitForIdle() do not join the terminal extension notification.
  // This handshake represents a continuing session, not a headless-exit promise.
  await finished.promise;
  await Bun.write(
    join(agentDir, "messages.json"),
    JSON.stringify(session.messages),
  );
} finally {
  await session.dispose();
}
