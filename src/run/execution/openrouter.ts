/**
 * OpenRouter runtime support.
 *
 * Stages with `runtime: openrouter` run on the Pi coding agent's built-in
 * `openrouter` provider. Pi speaks OpenRouter's OpenAI-compatible chat
 * completions API with function tools, so the stage keeps Pi's file and shell
 * tools whatever model family the stage selects. The API key reaches Pi only
 * through `OPENROUTER_API_KEY` in the child environment; it never appears in
 * argv, prompts, or any message built here.
 */

import { PI_JSON_MODE_ARGS } from "./pi-json.js";

export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

/** Pi's provider id for OpenRouter. */
const PI_OPENROUTER_PROVIDER = "openrouter";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/models";
const OPENROUTER_MODEL_EXAMPLE = "qwen/qwen3-coder-next";

/**
 * OpenRouter model ids are `<author>/<slug>`, optionally prefixed with `~`
 * (a "latest" alias) and suffixed with `:<variant>` such as `:free`. Checked
 * against every id OpenRouter's public model list served when this was written.
 */
const OPENROUTER_MODEL_ID =
  /^~?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*(?::[A-Za-z0-9._-]+)*$/;

/**
 * Returns why `model` cannot run on the `openrouter` runtime, or undefined when
 * it can. The runtime has no default model: OpenRouter routes to hundreds of
 * models and a silent default would bill the wrong one.
 */
export function openRouterModelProblem(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return `runtime openrouter requires a model. Set the stage model to an OpenRouter model id such as ${OPENROUTER_MODEL_EXAMPLE} (see ${OPENROUTER_MODELS_URL}).`;
  }
  if (!OPENROUTER_MODEL_ID.test(trimmed)) {
    return `runtime openrouter cannot use model ${JSON.stringify(trimmed)}: OpenRouter model ids look like <author>/<model>, for example ${OPENROUTER_MODEL_EXAMPLE} (see ${OPENROUTER_MODELS_URL}).`;
  }
  return undefined;
}

/**
 * Builds Pi print-mode arguments for an OpenRouter model.
 *
 * Pi strips exactly one leading `<provider>/` from `--model` when `--provider`
 * is also given, so the id is always passed as `openrouter/<id>`. That keeps
 * OpenRouter's own `openrouter/...` model ids intact instead of letting Pi
 * mistake their author for the provider prefix.
 */
export function createOpenRouterAgentArgs(model: string | undefined, nativeEffort?: string): string[] {
  const problem = openRouterModelProblem(model);
  if (problem) throw new Error(problem);
  return [
    "-p",
    ...PI_JSON_MODE_ARGS,
    ...(nativeEffort ? ["--thinking", nativeEffort] : []),
    "--provider",
    PI_OPENROUTER_PROVIDER,
    "--model",
    `${PI_OPENROUTER_PROVIDER}/${model!.trim()}`,
  ];
}

/** Pi's notice for ids missing from its bundled catalog; not a failure cause. */
function isPiWarning(line: string): boolean {
  return /^warning:/i.test(line.trim());
}

/**
 * Explains a failed OpenRouter run from Pi's stderr in terms an operator can
 * act on. Returns undefined when the output does not show a known cause, so
 * the caller keeps its generic exit message.
 *
 * Wording is deliberate: credential failures mention a rejected API key and
 * exhausted credits or rate limits say "quota exceeded" / "rate limit", which
 * is what the run blocker classifier keys on, so those runs block for the
 * operator instead of burning retries. Model and upstream provider failures
 * avoid those words and stay ordinary failures that follow the stage's retry
 * and fallback policy.
 */
export function describeOpenRouterFailure(input: {
  model?: string;
  stderr: string;
}): string | undefined {
  const text = input.stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() && !isPiWarning(line))
    .join("\n");
  if (!text) return undefined;
  const lower = text.toLowerCase();
  const model = input.model?.trim();
  const modelLabel = model ? ` ${model}` : "";

  if (/unknown provider "openrouter"/.test(lower)) {
    return "the installed Pi CLI has no openrouter provider. Upgrade Pi (npm install -g @earendil-works/pi-coding-agent) or point NITELY_PI_COMMAND at a current Pi.";
  }
  if (/no api key found for openrouter/.test(lower)) {
    return `Pi found no OpenRouter API key. Set ${OPENROUTER_API_KEY_ENV} or connect OpenRouter in the Web Console, then resume the run.`;
  }
  if (
    /(?:^|\n)\s*401\b/.test(text) ||
    /\buser not found\b/.test(lower) ||
    /\b(?:invalid|missing) (?:api )?key\b/.test(lower) ||
    /\bno auth credentials found\b/.test(lower)
  ) {
    return `OpenRouter rejected the API key (401). Replace ${OPENROUTER_API_KEY_ENV} or the OpenRouter connection in the Web Console with a valid key from https://openrouter.ai/settings/keys, then resume the run.`;
  }
  if (
    /(?:^|\n)\s*402\b/.test(text) ||
    /\b(?:insufficient|more) credits\b/.test(lower) ||
    /\bkey limit exceeded\b/.test(lower)
  ) {
    return "OpenRouter quota exceeded: the account or key has run out of credits or hit its spending limit (402). Add credits or raise the key limit at https://openrouter.ai/settings/credits, then resume the run.";
  }
  if (/(?:^|\n)\s*429\b/.test(text) || /\brate[-\s]?limit/.test(lower)) {
    return `OpenRouter rate limit reached for model${modelLabel} (429). Wait and resume the run, choose a less congested model or variant, or add credits to raise free-tier limits.`;
  }
  if (
    /(?:^|\n)\s*404\b/.test(text) ||
    /\bno endpoints found\b/.test(lower) ||
    /\bnot a valid model id\b/.test(lower) ||
    /\bmodel (?:is )?not (?:found|available)\b/.test(lower)
  ) {
    return `OpenRouter has no available endpoint for model${modelLabel}. Check the exact id at ${OPENROUTER_MODELS_URL} and any data-policy or provider restrictions on your OpenRouter account, then update the stage model.`;
  }
  if (
    /(?:^|\n)\s*(?:408|500|502|503|504)\b/.test(text) ||
    /\bprovider returned error\b/.test(lower) ||
    /\bno (?:allowed |available )?providers?\b/.test(lower) ||
    /\b(?:overloaded|timed out|timeout)\b/.test(lower)
  ) {
    return `OpenRouter or its upstream provider failed while serving model${modelLabel}. This is usually transient; the stage follows its normal retry policy. If it persists, check https://status.openrouter.ai or pick another model.`;
  }
  return undefined;
}
