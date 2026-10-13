import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  type CommandMediationMechanism,
  type CommandMediationPolicy,
} from "./command-mediation.js";

/** Supervisor installed by the OCI backend. x86_64 Linux only. */
export const OCI_COMMAND_MEDIATOR_ID = "oci-ptrace-seccomp";

export const OCI_COMMAND_MEDIATION_LIMITATION =
  "agent-spawned execve and execveat calls are mediated by oci-ptrace-seccomp on Linux x86_64 when capabilities.commands.advisory is false; advisory policies stay stated; if the mediator cannot be installed the stage fails closed before launch. In-process interpreter effects and non-exec shell builtins are outside this boundary";

const MEDIATOR_DIRECTORY = "/usr/local/lib/nitely-mediator";

export function commandMediatorScriptPath(): string | undefined {
  const beside = fileURLToPath(new URL("./command-mediator.py", import.meta.url));
  return existsSync(beside) ? beside : undefined;
}

/** True when this process can host the supervisor and the program is installed. */
export function ociCommandMediationSupported(): boolean {
  return (
    process.platform === "linux" &&
    process.arch === "x64" &&
    commandMediatorScriptPath() !== undefined
  );
}

export function createOciCommandMediationMechanism(): CommandMediationMechanism {
  return {
    id: OCI_COMMAND_MEDIATOR_ID,
    supports(policy) {
      return (
        policy.advisory === false &&
        policy.mode !== "unrestricted" &&
        ociCommandMediationSupported()
      );
    },
  };
}

export function commandPolicyDocument(policy: CommandMediationPolicy): string {
  return JSON.stringify({
    advisory: policy.advisory,
    allow: policy.allow,
    deny: policy.deny,
    mode: policy.mode,
    policyId: policy.policyId,
  });
}

/**
 * Argv that replaces the container command. The mediator process is not under
 * the filter; the first exec of `command` is the exempt runtime launch.
 */
export function commandMediatorContainerArgs(input: {
  command: string;
  args: readonly string[];
}): string[] {
  return [
    "python3",
    `${MEDIATOR_DIRECTORY}/command-mediator.py`,
    "--policy",
    `${MEDIATOR_DIRECTORY}/command-policy.json`,
    "--evidence",
    "/nitely/output/command-mediation.jsonl",
    "--",
    input.command,
    ...input.args,
  ];
}

export function commandMediatorMountSpec(hostDir: string): string {
  return `type=bind,src=${hostDir},dst=${MEDIATOR_DIRECTORY},readonly`;
}
