const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN = /(?:token|secret|password|api[_-]?key|apikey|authorization|cookie|auth|key)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueLongSecrets(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => typeof value === "string"))]
    .filter((value) => value.length >= 8);
}

export function collectEnvSecretValues(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  return uniqueLongSecrets(
    Object.entries(env)
      .filter(([key]) => SECRET_KEY_PATTERN.test(key))
      .map(([, value]) => value),
  );
}

function envPatternMatches(pattern: string, key: string): boolean {
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`,
  );
  return regex.test(key);
}

function collectPolicyEnvSecrets(
  policy: { redactEnv: string[] },
  env: Record<string, string | undefined>,
): string[] {
  if (policy.redactEnv.length === 0) return [];
  return Object.entries(env)
    .filter(([key, value]) =>
      value !== undefined &&
      value.length >= 8 &&
      policy.redactEnv.some((pattern) => envPatternMatches(pattern, key)),
    )
    .map(([, value]) => value as string);
}

export function collectContextRedactionSecrets(input: {
  policy: { redactEnv: string[] };
  processEnv?: Record<string, string | undefined>;
  providerEnv?: Record<string, string | undefined>;
}): string[] {
  const processEnv = input.processEnv ?? process.env;
  const secrets = [
    ...collectEnvSecretValues(processEnv),
    ...collectPolicyEnvSecrets(input.policy, processEnv),
  ];
  if (input.providerEnv) {
    secrets.push(...collectEnvSecretValues(input.providerEnv));
    secrets.push(...collectPolicyEnvSecrets(input.policy, input.providerEnv));
  }
  return [...new Set(secrets)];
}

export function redactText(
  value: string | undefined,
  extraSecrets: Iterable<string> = [],
): string | undefined {
  if (value === undefined) return undefined;

  let redacted = value;
  redacted = redacted.replace(
    /\b(authorization)(\s*:\s*bearer\s+)([^\s'"`<>]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b(token|secret|password|api[_-]?key|apikey|authorization|cookie|auth|key)(\s*[:=]\s*)([^\s'"`<>]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{10,})\b/g,
    REDACTED,
  );

  for (const secret of uniqueLongSecrets([
    ...collectEnvSecretValues(process.env),
    ...extraSecrets,
  ])) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  return redacted;
}

export function redactUnknown(
  value: unknown,
  extraSecrets: Iterable<string> = [],
): unknown {
  if (typeof value === "string") {
    return redactText(value, extraSecrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, extraSecrets));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactUnknown(item, extraSecrets),
      ]),
    );
  }
  return value;
}

export function redactForWeb(value: string | undefined): string | undefined {
  return redactText(value);
}

export function redactUnknownForWeb(
  value: unknown,
  extraSecrets: Iterable<string> = [],
): unknown {
  return redactUnknown(value, extraSecrets);
}
