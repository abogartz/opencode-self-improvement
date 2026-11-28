// A real SDK session in an isolated child, talking only to the local fake model.
import { join } from "node:path";
import { openSession } from "./session.ts";

const [cwd, agentDir, baseUrl, extensionPath, prompt] = process.argv.slice(2);
const { session, runtime } = await openSession(cwd, agentDir, baseUrl, {
  extensionPath,
});
try {
  await session.prompt(prompt);
  await Bun.write(
    join(agentDir, "messages.json"),
    JSON.stringify(session.messages),
  );
} finally {
  await runtime.dispose();
}
