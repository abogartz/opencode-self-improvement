import type { MemoryToolHost } from "../../host/contracts.ts";
import {
  sessionDirectoryFromMessages,
  sessionDirectoryFromRow,
  toolIdentity,
} from "./identity.ts";
import type { PluginCtx } from "./context.ts";

export function createOpenCodeHost(ctx: PluginCtx): MemoryToolHost {
  return {
    directories: {
      async fromTranscript(sessionID) {
        return sessionDirectoryFromMessages(
          await ctx.session?.context?.({ sessionID }),
        );
      },
      async fromSession(sessionID) {
        return sessionDirectoryFromRow(await ctx.session?.get?.({ sessionID }));
      },
    },
    async registerTools(register) {
      // Read APIs at call time and retain their receiver. Hosts can attach or
      // replace session APIs after setup, including on service instances.
      await ctx.tool?.transform((editor) => {
        register({
          add(tool) {
            editor.add({
              ...tool,
              options: { codemode: false },
              execute(args, context) {
                // No await before the shared tool captures caller identity.
                return tool.execute(args, toolIdentity(context));
              },
            });
          },
        });
      });
    },
  };
}
