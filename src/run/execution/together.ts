import type { Effort } from "../../flow/schema.js";

/**
 * Together AI agent runtime.
 *
 * Together AI serves open models through an OpenAI-compatible chat
 * completions API. Nitely does not ship its own agent loop, so the `together`
 * runtime drives the Pi coding agent, which has a built-in `together` provider
 * and keeps Pi's file and shell tools. Nitely owns the credential and the
 * model selection: it requires an explicit Together model id, passes
 * `--provider together --model <id>` to Pi, and hands the API key over only
 * through the `TOGETHER_API_KEY` environment variable (never argv).
 */

/** The variable Pi's built-in Together provider reads, and Nitely projects. */
export const TOGETHER_API_KEY_ENV = "TOGETHER_API_KEY";

/** Pi's provider id for Together AI. */
export const TOGETHER_PI_PROVIDER = "together";

/** Where operators can look up valid Together model ids. */
export const TOGETHER_MODELS_URL = "https://api.together.ai/models";

/** A model id used in setup messages and documentation. */
export const TOGETHER_EXAMPLE_MODEL = "moonshotai/Kimi-K3";

// Together model ids are "<organization>/<model>" (dedicated endpoints use
// "<account>/<model>-<suffix>"). Pi also accepts a trailing ":<thinking>" level.
const TOGETHER_MODEL_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)+(?::[a-z]+)?$/;

/**
 * Returns an actionable reason when `model` cannot select a Together model,
 * or undefined when it can. An omitted model is rejected rather than left to
 * whatever default the local Pi installation would pick.
 */
export function togetherModelProblem(model: string | undefined): string | undefined {
  const example = `for example "model": "${TOGETHER_EXAMPLE_MODEL}"`;
  if (model === undefined || model.trim() === "") {
    return `agent runtime together requires a Together AI model id. Set the stage's model, ${example}; see ${TOGETHER_MODELS_URL} for available models.`;
  }
  const trimmed = model.trim();
  const id = trimmed.toLowerCase().startsWith(`${TOGETHER_PI_PROVIDER}/`)
    ? trimmed.slice(TOGETHER_PI_PROVIDER.length + 1)
    : trimmed;
  if (!TOGETHER_MODEL_PATTERN.test(id)) {
    return `agent runtime together does not support model "${model}": Together AI model ids have the form <organization>/<model>, ${example}; see ${TOGETHER_MODELS_URL} for available models.`;
  }
  return undefined;
}

export function createTogetherAgentArgs(model?: string, effort?: Effort): string[] {
  return [
    "-p",
    ...(effort ? ["--thinking", effort] : []),
    "--provider",
    TOGETHER_PI_PROVIDER,
    ...(model ? ["--model", model.trim()] : []),
  ];
}

const CREDENTIAL_FAILURE =
  /\b401\b|\b403\b|unauthori[sz]ed|invalid[\s_-]?api[\s_-]?key|incorrect api key|authentication[\s_-]?(?:failed|error)|no api key/i;
const MODEL_FAILURE =
  /model_not_available|unable to access (?:the )?model|model\b[^\n]{0,200}\b(?:does not exist|is not (?:available|supported))|invalid model|unknown model|\b404\b/i;
const PROVIDER_MISSING = /unknown provider "together"/i;

function firstMatchingLine(output: string, pattern: RegExp): string | undefined {
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    // Pi warns `Model "<id>" not found for provider "together". Using custom
    // model id.` for any id missing from its bundled catalog, and still sends
    // the request; the warning is not the cause of a failure.
    .filter((candidate) => !/^warning:/i.test(candidate))
    .find((candidate) => pattern.test(candidate));
  if (!line) return undefined;
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/**
 * Turns a failed Pi session against Together AI into an operator-facing
 * explanation, when its error output shows a credential or model problem.
 * Only stderr is inspected: in print mode Pi reports request failures there,
 * while stdout carries the agent's own answer, which may discuss anything.
 */
export function describeTogetherFailure(input: {
  model?: string;
  stderr: string;
}): string | undefined {
  const output = input.stderr;
  const provider = firstMatchingLine(output, PROVIDER_MISSING);
  if (provider) {
    return `The installed Pi CLI has no built-in Together AI provider (Pi reported: ${provider}). Upgrade Pi or point NITELY_PI_COMMAND at a Pi version that includes it.`;
  }
  const credential = firstMatchingLine(output, CREDENTIAL_FAILURE);
  if (credential) {
    return `Together AI rejected the API key or none reached Pi (Pi reported: ${credential}). Replace the Together AI connection in the Web Console or set ${TOGETHER_API_KEY_ENV}, then retry.`;
  }
  const model = firstMatchingLine(output, MODEL_FAILURE);
  if (model) {
    const name = input.model ? ` "${input.model}"` : "";
    return `Together AI could not serve model${name} (Pi reported: ${model}). Set the stage's model to a chat model id listed at ${TOGETHER_MODELS_URL}, for example "${TOGETHER_EXAMPLE_MODEL}".`;
  }
  return undefined;
}
