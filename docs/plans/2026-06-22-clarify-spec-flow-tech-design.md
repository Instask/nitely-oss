# Clarify Spec Flow Tech Design

## Goal

Add a deterministic clarify-spec command and library that identifies material
ambiguity, limits questions to five, and writes accepted answers back into local
Markdown specs.

## Design

### Clarification Module

Add `src/spec-artifacts/clarify.ts` with:

- `analyzeSpecClarifications(markdown, options)`
- `applySpecClarificationAnswers(markdown, input)`
- `ClarificationQuestion`
- `ClarificationAnswer`

The analyzer uses conservative heuristics across the #104 categories. It should
prefer existing structured spec IDs from `parseStructuredSpec()` so each
question can cite a relevant `FR-###`, `SC-###`, or section.

### Question Shape

Each question includes:

- stable `id` such as `CQ-001`
- `category`
- `question`
- `targetId` or `targetSection`
- two to three `options`
- `recommendedOptionId`
- `rationale`

Questions are sorted by category priority and capped at five.

### Write-Back

`applySpecClarificationAnswers()` appends entries under `## Clarifications`:

```markdown
## Clarifications

### 2026-06-22 session abc123

- **CQ-001 / FR-001:** Selected `A`: ...
```

It also updates the referenced list item when possible by appending a short
`Clarification:` sentence to that item. If no target item exists, only the
Clarifications section is updated.

### CLI

Add:

```bash
nitely clarify-spec <spec.md> [--answer CQ-001=A] [--session <id>] [--date YYYY-MM-DD]
```

No answers: print questions as JSON and do not modify the file. With answers:
write the file back and print the number of applied clarifications.

## Validation

- Unit tests for analysis categories, five-question cap, clean specs, and
  write-back preservation.
- CLI tests for JSON question output and accepted answer write-back.
- Full `pnpm run check` and `pnpm test:run`.

## Rollback

Revert the PR. The command is additive and does not migrate existing specs.
