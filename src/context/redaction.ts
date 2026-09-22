const REDACTED = "[REDACTED]";

const SAFE_TOKEN_COUNT_KEYS = new Set([
  "approxtokens",
  "approxtokensafter",
  "approxtokensbefore",
  "cachecreationinputtokens",
  "cachedinputtokens",
  "cachereadinputtokens",
  "contextapproxtokens",
  "contexttokens",
  "flowmaxinputtokens",
  "flowmaxtooloutputtokens",
  "inputtokens",
  "iotokens",
  "maxinputtokens",
  "maxtokens",
  "maxtooloutputtokens",
  "numtokens",
  "outputtokens",
  "runtimetokens",
  "totaltokens",
  "trimmedtokensafter",
  "trimmedtokensbefore",
  "uncachedinputtokens",
]);

export function isSafeTokenCountField(
  key: string,
  value: unknown,
): value is number {
  const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
  return SAFE_TOKEN_COUNT_KEYS.has(normalized) &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

export function isSensitiveKey(value: string): boolean {
  return /(?:token|secret|password|passwd|passphrase|credential|api[_-]?key|apikey|private[_-]?key|authorization|cookie)/i.test(
    value,
  ) ||
    /(?:oauth|(?:^|[_-])auth(?:[_-]|$))/i.test(value) ||
    /^auth(?:[A-Z0-9_]|$)/u.test(value) ||
    /^(?:auth|key)$/i.test(value) ||
    /(?:^|[_-])(?:auth|key)$/i.test(value) ||
    /[a-z0-9](?:Auth|Key)$/u.test(value);
}

function containsSensitiveAssignment(value: string): boolean {
  for (const match of value.matchAll(
    /\b([A-Za-z][A-Za-z0-9_-]*)(?:\s*[:=]\s*)[^\s'"`<>]+/g,
  )) {
    if (isSensitiveKey(match[1] ?? "")) return true;
  }
  return false;
}

export function containsSensitiveText(value: string): boolean {
  return /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value) ||
    /\bbearer\s+[^\s'"`<>]+/i.test(value) ||
    containsSensitiveAssignment(value) ||
    /\b(?:token|secret|password|passwd|passphrase|credential|api[_-]?key|apikey|private[_-]?key|authorization|cookie|auth|key)\s*[:=]\s*[^\s'"`<>]+/i.test(
      value,
    ) ||
    /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{10,})\b/.test(
      value,
    ) ||
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueLongSecrets(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => typeof value === "string"))]
    .filter((value) => value.length >= 8);
}

function uniqueExplicitSecrets(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((value) => value.length > 0);
}

export function collectEnvSecretValues(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  return uniqueLongSecrets(
    Object.entries(env)
      .filter(([key]) => isSensitiveKey(key))
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
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    (_match, scheme: string) => `${scheme}${REDACTED}:${REDACTED}@`,
  );
  redacted = redacted.replace(
    /\b(authorization)(\s*:\s*bearer\s+)([^\s'"`<>]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b(bearer)(\s+)([^\s'"`<>]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b(token|secret|password|passwd|passphrase|credential|api[_-]?key|apikey|private[_-]?key|authorization|cookie|auth|key)(\s*[:=]\s*)([^\s'"`<>]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b([A-Za-z][A-Za-z0-9_-]*token[A-Za-z0-9_-]*)(\s*[:=]\s*)([^\s'"`<>]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  );
  redacted = redacted.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
    REDACTED,
  );
  redacted = redacted.replace(
    /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{10,})\b/g,
    REDACTED,
  );

  for (const secret of [
    ...uniqueLongSecrets(collectEnvSecretValues(process.env)),
    ...uniqueExplicitSecrets(extraSecrets),
  ].sort((left, right) => right.length - left.length)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  return redacted;
}

export function redactUnknown(
  value: unknown,
  extraSecrets: Iterable<string> = [],
): unknown {
  const secrets = [
    ...extraSecrets,
    ...collectSensitiveStringValues(value),
  ];
  return redactUnknownValue(value, secrets);
}

export function collectSensitiveStringValues(value: unknown): string[] {
  const pending: Array<{ value: unknown; sensitiveAncestor: boolean }> = [
    { value, sensitiveAncestor: false },
  ];
  const seen = new WeakMap<object, boolean>();
  const secrets = new Set<string>();
  while (pending.length > 0) {
    const currentEntry = pending.pop();
    if (!currentEntry) continue;
    const { value: current, sensitiveAncestor } = currentEntry;
    if (typeof current === "string") {
      if (sensitiveAncestor) secrets.add(current);
      continue;
    }
    if (typeof current !== "object" || current === null) {
      continue;
    }
    const previousSensitivity = seen.get(current);
    if (previousSensitivity === true || previousSensitivity === sensitiveAncestor) {
      continue;
    }
    seen.set(current, sensitiveAncestor);
    let entries: Array<[string, unknown]>;
    try {
      entries = Array.isArray(current)
        ? current.map((entry, index) => [String(index), entry])
        : Object.entries(current);
    } catch {
      continue;
    }
    for (const [key, entry] of entries) {
      const sensitive = sensitiveAncestor ||
        (isSensitiveKey(key) && !isSafeTokenCountField(key, entry));
      if (sensitive && typeof entry === "string") {
        secrets.add(entry);
      }
      if (typeof entry === "object" && entry !== null) {
        pending.push({ value: entry, sensitiveAncestor: sensitive });
      }
    }
  }
  return [...secrets];
}

function redactUnknownValue(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknownValue(item, secrets));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const redactedKey = redactText(key, secrets) ?? key;
        return [
          redactedKey,
          isSensitiveKey(key) && !isSafeTokenCountField(key, item)
            ? REDACTED
            : redactUnknownValue(item, secrets),
        ];
      }),
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
