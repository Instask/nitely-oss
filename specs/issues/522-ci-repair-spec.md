# Issue #522 — Bounded CI-failure repair core

This slice defines the safe admission and evidence contract for an operator-
submitted GitHub check failure before provider/UI wiring.

- only GitHub observations are admitted;
- source identity is immutable across duplicate submissions;
- failure excerpts are ANSI-cleaned, redacted, and bounded;
- stale PR heads fail closed;
- infrastructure/flaky and unclear/spec failures never trigger code repair;
- remote CI observations are capped at two;
- local verification and structured review must pass before a repair cycle can
  be admitted.

Provider API and Web/CLI intake remain follow-up wiring against this seam; no
autonomous repair or merge is enabled by this core module.
