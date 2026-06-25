import { describe, expect, it } from "vitest";

import {
  collectEnvSecretValues,
  redactText,
  redactUnknown,
} from "../../src/context/redaction.js";

describe("context redaction", () => {
  it("redacts common key/value secret forms", () => {
    const text = [
      "token=tok_1234567890",
      "password: hunter2value",
      "api_key = sk-test-value",
      "generic key: ssh-rsa-secret",
      "cookie=session-value",
    ].join("\n");

    const redacted = redactText(text);

    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).toContain("password: [REDACTED]");
    expect(redacted).toContain("api_key = [REDACTED]");
    expect(redacted).toContain("key: [REDACTED]");
    expect(redacted).toContain("cookie=[REDACTED]");
    expect(redacted).not.toContain("tok_1234567890");
    expect(redacted).not.toContain("hunter2value");
  });

  it("redacts bearer, GitHub, OpenAI, and explicit extra secret values", () => {
    const text = [
      "Authorization: Bearer bearer-secret-value",
      "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH",
      "ghp_1234567890abcdefghijklmnopqrstuv",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "provider=stored-secret-value",
    ].join("\n");

    const redacted = redactText(text, ["stored-secret-value"]);

    expect(redacted).not.toContain("bearer-secret-value");
    expect(redacted).not.toContain("github_pat_");
    expect(redacted).not.toContain("ghp_1234567890");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("stored-secret-value");
    expect(redacted?.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("collects only long environment values from secret-like keys", () => {
    expect(
      collectEnvSecretValues({
        OPENAI_API_KEY: "sk-live-secret-value",
        PASSWORD: "short",
        PUBLIC_URL: "https://example.test",
      }),
    ).toEqual(["sk-live-secret-value"]);
  });

  it("redacts nested unknown values without changing non-strings", () => {
    expect(
      redactUnknown({
        nested: ["token=abc123456789", 42, true],
      }),
    ).toEqual({
      nested: ["token=[REDACTED]", 42, true],
    });
  });
});
