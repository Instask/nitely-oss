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
      "passphrase: phrase-value-123",
      "credential=credential-value-123",
      "api_key = sk-test-value",
      "private_key = private-key-value-123",
      "accessTokens=access-token-value-123",
      "refresh_tokens=refresh-token-value-123",
      "accessTokensList=listed-token-value-123",
      "inputTokens=120",
      "generic key: ssh-rsa-secret",
      "cookie=session-value",
    ].join("\n");

    const redacted = redactText(text);

    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).toContain("password: [REDACTED]");
    expect(redacted).toContain("passphrase: [REDACTED]");
    expect(redacted).toContain("credential=[REDACTED]");
    expect(redacted).toContain("api_key = [REDACTED]");
    expect(redacted).toContain("private_key = [REDACTED]");
    expect(redacted).toContain("accessTokens=[REDACTED]");
    expect(redacted).toContain("refresh_tokens=[REDACTED]");
    expect(redacted).toContain("accessTokensList=[REDACTED]");
    expect(redacted).toContain("inputTokens=[REDACTED]");
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

  it("redacts explicitly supplied short secrets", () => {
    expect(redactText("value=xy", ["xy"])).toBe("value=[REDACTED]");
  });

  it("collects only long environment values from secret-like keys", () => {
    expect(
      collectEnvSecretValues({
        OPENAI_API_KEY: "sk-live-secret-value",
        SSH_PASSPHRASE: "ssh-passphrase-value",
        SSH_KEY: "ssh-private-material-value",
        BASIC_AUTH: "basic-auth-value",
        NITELY_AUTH_STATE: "auth-state-secret-value",
        SERVICE_CREDENTIAL: "service-credential-value",
        SIGNING_PRIVATE_KEY: "signing-private-key-value",
        PASSWORD: "short",
        PUBLIC_URL: "https://example.test",
      }),
    ).toEqual([
      "sk-live-secret-value",
      "ssh-passphrase-value",
      "ssh-private-material-value",
      "basic-auth-value",
      "auth-state-secret-value",
      "service-credential-value",
      "signing-private-key-value",
    ]);
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

  it("redacts sensitive structured fields and copies of their values", () => {
    const passphrase = "structured-passphrase-value";
    const privateKey = "structured-private-key-value";
    const credential = "structured-credential-value";

    const redacted = redactUnknown({
      passphrase,
      private_key: privateKey,
      credential,
      nested: {
        note: `copies ${passphrase} ${privateKey} ${credential}`,
      },
    });

    expect(redacted).toEqual({
      passphrase: "[REDACTED]",
      private_key: "[REDACTED]",
      credential: "[REDACTED]",
      nested: {
        note: "copies [REDACTED] [REDACTED] [REDACTED]",
      },
    });
  });

  it("redacts plural credential tokens without redacting usage counters", () => {
    const accessToken = "structured-access-token-value";
    const refreshToken = "structured-refresh-token-value";
    const disguisedAccessToken = "structured-disguised-access-token-value";
    const disguisedRefreshToken = "structured-disguised-refresh-token-value";
    const listedAccessToken = "structured-listed-access-token-value";
    const fakeInputCount = "opaque-secret-in-input-token-count";

    expect(
      redactUnknown({
        accessTokens: [accessToken],
        refresh_tokens: refreshToken,
        accessInputTokens: disguisedAccessToken,
        refreshOutputTokens: disguisedRefreshToken,
        accessTokensList: listedAccessToken,
        inputTokens: 12,
        outputTokens: 3,
        cachedInputTokens: 4,
        approxTokensBefore: 120,
        approxTokensAfter: 40,
        trimmedTokensBefore: 120,
        trimmedTokensAfter: 40,
        invalidUsage: {
          inputTokens: fakeInputCount,
        },
        nested: {
          note:
            `copies ${accessToken} ${refreshToken} ${disguisedAccessToken} ${disguisedRefreshToken} ${listedAccessToken} ${fakeInputCount}`,
        },
      }),
    ).toEqual({
      accessTokens: "[REDACTED]",
      refresh_tokens: "[REDACTED]",
      accessInputTokens: "[REDACTED]",
      refreshOutputTokens: "[REDACTED]",
      accessTokensList: "[REDACTED]",
      inputTokens: 12,
      outputTokens: 3,
      cachedInputTokens: 4,
      approxTokensBefore: 120,
      approxTokensAfter: 40,
      trimmedTokensBefore: 120,
      trimmedTokensAfter: 40,
      invalidUsage: {
        inputTokens: "[REDACTED]",
      },
      nested: {
        note:
          "copies [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]",
      },
    });
  });
});
