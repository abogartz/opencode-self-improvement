import { expect, test } from "bun:test";
import {
  completionFailure,
  providerRequest,
} from "../../src/adapters/completion-error.ts";

test("completion diagnostics allow only fixed categories, never provider fields", async () => {
  const secret = "opaqueFixtureCredential7f35a19cd2b64801";
  expect(completionFailure(secret).message).toBe(
    "Capture completion failed (invalid_response)",
  );
  expect(completionFailure("error").message).toBe(
    "Capture completion failed (provider_error)",
  );
  expect(completionFailure("length").message).toBe(
    "Capture completion failed (output_limit)",
  );
  expect(completionFailure("aborted").message).toBe(
    "Capture completion failed (aborted)",
  );
  expect(completionFailure("stop", true).message).toBe(
    "Capture completion failed (tool_call)",
  );
  for (const reject of [
    () => {
      throw new Error(secret);
    },
    () => Promise.reject(new Error(secret)),
  ]) {
    const error = await providerRequest(reject).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Capture completion failed (request_failed)");
    expect(error.cause).toBeUndefined();
  }
});
