import { writeFileSync } from "node:fs";

export const FOOTER = "READ-FORMATTER-FOOTER-462";
export type Formatter = "limit" | "footer" | "clip" | "repeat-clip";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
}

interface ReadEvent {
  tool: string;
  status: string;
  sessionID: string;
  id: string;
  result: ToolResult;
}

interface Context {
  tool: {
    hook(
      name: "execute.after",
      callback: (event: ReadEvent) => void,
    ): Promise<unknown>;
  };
}

export interface FormatterTrace {
  sid: string;
  callID: string;
  before: string;
  after: string;
}

export default {
  id: "pull-formatter-fixture",
  setup: async (ctx: Context) => {
    const mode = process.env.E2E_PULL_FORMATTER;
    const tracePath = process.env.E2E_PULL_FORMATTER_TRACE;
    if (
      !tracePath ||
      !["limit", "footer", "clip", "repeat-clip"].includes(mode ?? "")
    ) {
      throw new Error(
        "pull formatter fixture is missing its mode or trace path",
      );
    }
    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== "read" || event.status !== "completed") return;
      const parts = event.result.content.filter((part) => part.type === "text");
      const before = parts.map((part) => part.text).join("\n");
      if (mode === "footer") {
        const last = parts.at(-1);
        if (!last) throw new Error("read result has no text part");
        last.text += `\n${FOOTER}`;
      } else {
        const text =
          mode === "limit" ? before.slice(0, 200) : before.slice(0, -8);
        event.result.content = [
          {
            type: "text",
            text: mode === "repeat-clip" ? text + "\n" + text : text,
          },
        ];
      }
      const after = event.result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const trace: FormatterTrace = {
        sid: event.sessionID,
        callID: event.id,
        before,
        after,
      };
      writeFileSync(tracePath, JSON.stringify(trace));
    });
  },
};
