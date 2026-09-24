# Draft Technical Design Generation Tech Design

## Goal

Generate a draft technical design from an approved structured spec and
lightweight repository context, then block implementation until the plan is
approved.

## Design

### Generator

Add `src/plan-artifacts/draft.ts`.

Inputs:

- approved structured spec Markdown
- repository context

Output:

- Markdown using `docs/templates/nitely-technical-plan.md` structure
- `Status: draft`
- `PD-###` decisions
- trace links to discovered `US-###`, `FR-###`, and `SC-###`
- open questions when context is insufficient

### Repository Context

The first slice reads cheap local context only:

- `package.json` scripts
- top-level `src`, `test`, `docs`, `specs`, `flows` presence
- first-level files under likely source/test directories

No broad source scan and no agent call.

### Task Persistence

Extend legacy task records with:

- `techDesignStatus?: "draft" | "approved"`

Add a helper to overwrite the task's `tech-design.md`, set
`techDesignStatus: "draft"`, and keep the task otherwise unchanged.

### Web API

Add `POST /api/tasks/:id/draft-tech-design`.

The endpoint:

1. resolves the scoped task
2. rejects `specStatus: "draft"`
3. validates/parses the structured spec
4. collects repository context
5. writes draft `tech-design.md`
6. returns updated task and draft text

### Run Blocking

The existing task run endpoint rejects `techDesignStatus: "draft"` before
calling `runFlow()`.

## Validation

Add unit tests for generator output and Web API tests for approved-spec
requirement, missing-context behavior, persistence, and run blocking.

## Rollback

Revert the PR. Existing tasks without `techDesignStatus` continue to run as
before.
