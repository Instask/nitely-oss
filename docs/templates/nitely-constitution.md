# Nitely Project Constitution

## Principles

1. Code, secrets, worktrees, and agent execution stay in the customer's environment unless explicitly configured otherwise.
2. Every run must produce durable state, logs, and evidence sufficient for review and recovery.
3. Failures must be explicit, recoverable, and auditable.
4. Published PRs must include evidence for inputs, stages, commands, verification, and generated artifacts.
5. Human approval gates must not be silently bypassed.
6. Flow schema changes require compatibility or migration notes.
7. Security-sensitive output must be redacted before appearing in prompts, logs, events, evidence, or any future control-plane upload.

## Review Expectations

- Prefer small, reviewable changes over broad autonomous rewrites.
- Preserve source-of-truth artifacts and link implementation evidence back to them.
- Do not hide runtime, credential, or policy failures behind generic success states.
