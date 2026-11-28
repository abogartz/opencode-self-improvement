import { join } from "node:path";
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export async function openSession(
  cwd: string,
  agentDir: string,
  baseUrl: string,
  options: {
    extensionPath?: string;
    extensions?: ExtensionFactory[];
    persistent?: boolean;
    sessionFile?: string;
    retry?: boolean;
  } = {},
) {
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl,
          apiKey: "fake-key",
          models: [
            {
              id: "scripted",
              name: "Scripted",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false, keepRecentTokens: 0 },
          retry: {
            enabled: options.retry ?? false,
            maxRetries: 1,
            baseDelayMs: 1,
          },
        }),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          additionalExtensionPaths: options.extensionPath
            ? [options.extensionPath]
            : [],
          extensionFactories: options.extensions,
          systemPrompt:
            "You are an AI agent. Use the requested tools. This is an isolated memory integration test.",
        },
      });
      const opened = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: services.modelRuntime.getModel("fixture", "scripted"),
      });
      if (opened.extensionsResult.errors.length)
        throw new Error(JSON.stringify(opened.extensionsResult.errors));
      return { ...opened, services, diagnostics: services.diagnostics };
    },
    {
      cwd,
      agentDir,
      sessionManager: options.sessionFile
        ? SessionManager.open(options.sessionFile)
        : options.persistent
          ? SessionManager.create(cwd, join(agentDir, "sessions"))
          : SessionManager.inMemory(cwd),
    },
  );
  const bind = async (session: typeof runtime.session) => {
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        throw new Error(`extension runtime error: ${JSON.stringify(error)}`);
      },
    });
  };
  runtime.setRebindSession(bind);
  try {
    await bind(runtime.session);
    return {
      runtime,
      get session() {
        return runtime.session;
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
