# Task Breakdown Artifact Tech Design

## Overview

Issue #106 is the structural precursor to scoped implementation runs. The first increment should avoid UI or execution coupling and instead provide the stable artifact format and parser that #108 can consume.

## Format

Task files are Markdown. Each task line uses:

```markdown
- [ ] T001 [P] [US-001] Implement behavior in `src/module.ts` (depends: T000)
```

Supported metadata:

- checkbox state: `[ ]` or `[x]`
- task ID: `T###`
- optional parallel marker: `[P]`
- optional story marker: `[US-###]`
- dependencies: `(depends: T001,T002)`
- file paths: backticked paths in the task title
- phase/story grouping: `##` through `####` headings

## Parser API

Add `src/task-artifacts/parse.ts` with:

- `parseTaskArtifact(markdown): ParsedTaskArtifact`
- `validateTaskArtifact(markdown): ParsedTaskArtifact`
- `taskArtifactTemplate`

`ParsedTaskArtifact` includes `valid`, `tasks`, `phases`, and `diagnostics`.

## Validation

Diagnostics are non-throwing so Web Console, CLI, and planner flows can show all issues at once:

- duplicate task ID
- checkbox task missing a stable task ID
- task-like bullet missing checkbox syntax

## Non-Goals

- Running scoped tasks. That is #108.
- Generating tasks with an LLM.
- Persisting task completion state outside the Markdown artifact.
- Web Console editing UI.
