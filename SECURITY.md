# Security Policy

Nitely runs local agent CLIs, shell commands, Git operations, and repository
worktrees with the permissions of the user or host that starts it. Treat a
Nitely run as execution of untrusted generated code until a human has reviewed
the resulting changes and evidence.

## Reporting Vulnerabilities

Do not open a public issue for vulnerabilities that expose secrets, repository
contents, authentication material, private prompts, or bypasses of execution and
redaction boundaries.

Use GitHub private vulnerability reporting or a private maintainer channel for:

- credential, token, or prompt disclosure;
- repository path traversal or unintended file access;
- bypasses of `.nitely` context policy or redaction;
- unsafe execution sandbox defaults;
- runner/control-plane metadata upload boundary bypasses;
- dependency supply-chain issues that affect local execution.

If no private channel is available yet, open a public issue with only a short
request for a security contact and no exploit details.

## Supported Versions

This repository is pre-1.0. Security fixes target the current `main` branch
until tagged releases exist. After public release, supported release lines will
be documented here.

## Security Boundaries

The open source core is responsible for:

- local flow parsing and validation;
- local worktree execution;
- provider credential access from the local environment or local provider store;
- context policy, prompt construction, redaction, artifacts, evidence, and run
  events;
- runner/control-plane metadata-only protocol checks.

Commercial or hosted services must not weaken these boundaries by requiring raw
customer source, provider credentials, full logs, or prompts unless an explicit
auditable policy allows it.
