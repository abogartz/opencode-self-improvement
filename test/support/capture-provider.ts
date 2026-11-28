/** A chat provider that rejects completions without a user turn. */
export function captureProvider(errorMessage?: string) {
  const requests: {
    messages: { role: string; content: unknown }[];
    tools?: unknown[];
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json();
      requests.push(body);
      const error =
        errorMessage ??
        (!body.messages?.some((m: { role: string }) => m.role === "user")
          ? "No user query found in messages."
          : undefined);
      if (error)
        return Response.json(
          { error: { message: error, type: "invalid_request_error" } },
          { status: 400 },
        );
      const chunks = [
        {
          delta: { role: "assistant", content: "CAPTURE-OK" },
          finish_reason: null,
        },
        { delta: {}, finish_reason: "stop" },
      ].map((choice) => ({
        id: "capture-test",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
        choices: [{ index: 0, ...choice }],
      }));
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { server, requests, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}
