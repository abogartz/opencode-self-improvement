/** Provider text is untrusted and may echo credentials without recognizable prefixes. */
export function completionFailure(reason?: unknown, toolCall = false): Error {
  let code = "invalid_response";
  switch (reason) {
    case undefined:
      code = "request_failed";
      break;
    case "error":
      code = "provider_error";
      break;
    case "aborted":
      code = "aborted";
      break;
    case "length":
      code = "output_limit";
      break;
    case "toolUse":
      code = "tool_call";
      break;
  }
  if (toolCall) code = "tool_call";
  return new Error(`Capture completion failed (${code})`);
}

/** Never attach the original exception as a cause or interpolate its fields. */
export async function providerRequest<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw completionFailure();
  }
}
