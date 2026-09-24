import {
  outputContract,
  outputId,
  type Flow,
  type Stage,
} from "../flow/schema.js";

const LONG_RUNNING_COMMAND_PATTERN =
  /\b(?:npm|pnpm|yarn|vitest|jest|playwright|test|build|deploy|ssh|curl|docker|kubectl|terraform)\b/i;

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:api[_-]?key|secret|token|password|passwd|private[_ -]?key)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/i,
];

function warning(code: string, message: string): string {
  return `[production-lint:${code}] ${message}`;
}

function stagePrompt(stage: Stage): string | undefined {
  return "prompt" in stage ? stage.prompt : undefined;
}

function stageCommand(stage: Stage): string | undefined {
  return "command" in stage ? stage.command : undefined;
}

function isAgentLikeStage(stage: Stage): boolean {
  return stage.type === "agent" || stage.type === "judge" || (stage.type === "gate" && stage.mode === "review");
}

function isLongRunningStage(stage: Stage): boolean {
  const command = stageCommand(stage);
  if (!command) return false;
  return LONG_RUNNING_COMMAND_PATTERN.test(command);
}

function hasTimeout(stage: Stage): boolean {
  return (
    ("timeoutMs" in stage && typeof stage.timeoutMs === "number") ||
    typeof stage.timeouts?.commandMs === "number" ||
    typeof stage.timeouts?.gateMs === "number"
  );
}

function stageByProducedArtifact(flow: Flow): Map<string, Stage> {
  const producers = new Map<string, Stage>();
  for (const stage of flow.spec.stages) {
    for (const output of stage.outputs) {
      producers.set(outputId(output), stage);
    }
  }
  return producers;
}

function hasReviewEvidence(stage: Stage, producers: Map<string, Stage>): boolean {
  return stage.inputs.some((input) => {
    const producer = producers.get(input);
    return (
      /review/i.test(input) ||
      (producer?.type === "gate" &&
        (producer.mode === "review" || producer.mode === "review-aggregate")) ||
      producer?.type === "judge"
    );
  });
}

function hasVerificationEvidence(stage: Stage, producers: Map<string, Stage>): boolean {
  return stage.inputs.some((input) => {
    const producer = producers.get(input);
    return (
      /(test|verify|verification|conformance|evidence|audit)/i.test(input) ||
      producer?.type === "command" ||
      (producer?.type === "gate" && producer.mode === "deterministic")
    );
  });
}

function containsSecretLikeValue(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export function lintFlowProduction(flow: Flow): string[] {
  const warnings: string[] = [];
  const producers = stageByProducedArtifact(flow);

  for (const stage of flow.spec.stages) {
    if (isAgentLikeStage(stage) && stage.alwaysRun !== true) {
      if (stage.inputs.length >= 6 || stage.outputs.length >= 4) {
        warnings.push(
          warning(
            "broad-stage",
            `stage ${stage.id} has ${stage.inputs.length} inputs and ${stage.outputs.length} outputs; split broad responsibilities or document why they must stay together`,
          ),
        );
      }
    }

    if (isLongRunningStage(stage) && !hasTimeout(stage)) {
      warnings.push(
        warning(
          "missing-timeout",
          `stage ${stage.id} runs a likely long-running command without timeoutMs or timeouts.commandMs/gateMs`,
        ),
      );
    }

    const prompt = stagePrompt(stage);
    if (prompt && containsSecretLikeValue(prompt)) {
      warnings.push(
        warning(
          "secret-like-value",
          `stage ${stage.id} prompt appears to contain a credential-like value`,
        ),
      );
    }

    const command = stageCommand(stage);
    if (command && containsSecretLikeValue(command)) {
      warnings.push(
        warning(
          "secret-like-value",
          `stage ${stage.id} command appears to contain a credential-like value`,
        ),
      );
    }

    for (const output of stage.outputs) {
      if (typeof output === "string") continue;
      const contract = outputContract(output);
      const declaresContractShape =
        contract.type !== undefined ||
        contract.mediaType !== undefined ||
        contract.schema !== undefined ||
        contract.version !== undefined;
      if (declaresContractShape && contract.description === undefined) {
        warnings.push(
          warning(
            "weak-artifact-contract",
            `stage ${stage.id} output ${contract.id} declares a structured artifact without a description`,
          ),
        );
      }
    }

    if (stage.type === "publish-change" || stage.type === "update-change") {
      if (!hasReviewEvidence(stage, producers)) {
        warnings.push(
          warning(
            "missing-review-evidence",
            `stage ${stage.id} ${stage.type} does not consume review evidence`,
          ),
        );
      }
      if (!hasVerificationEvidence(stage, producers)) {
        warnings.push(
          warning(
            "missing-verification-evidence",
            `stage ${stage.id} ${stage.type} does not consume verification or test evidence`,
          ),
        );
      }
    }
  }

  return warnings;
}
