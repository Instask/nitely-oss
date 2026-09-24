# Issue #10 Specification: Web Console MVP

GitHub issue: https://github.com/Instask/nitely/issues/10

## Objective

Add a user-facing Web Console for Nitely so users can create and manage tasks,
start implementation runs from specifications and technical designs, inspect run
status and logs, and configure provider connections.

## Current State

Nitely is currently a local-first CLI/runtime. Users must create spec and tech
design files manually, invoke `nitely run` from a shell, and inspect generated
files under `.nitely/runs`. There is no browser UI, task model, API server, or
provider connection page.

## Required Behavior

- Add a Web Console that runs locally on the deployed machine.
- Provide a task list view with task status, title, created time, latest run,
  and change request URL when available.
- Provide a create task flow that accepts:
  - task title
  - specification text
  - technical design text
  - optional GitHub issue URL
  - target flow, defaulting to `flows/implement-spec-bootstrap.json`
- Persist task records under `.nitely/tasks` using JSON files so the MVP does
  not require a separate database migration.
- Materialize submitted specification and technical design text into stable
  files under each task directory and use those files as local-file inputs for
  Nitely runs.
- Allow a user to start a run for a task from the UI.
- Provide run list and run detail views that read existing run metadata from
  `.nitely/runs`, including branch, worktree path, completed stages, inputs,
  and change request URL.
- Provide log/evidence links or rendered text when stage logs and evidence
  files exist.
- Provide provider connection settings for:
  - Codex/OpenAI via local Codex CLI status and/or environment hints.
  - Claude/Anthropic via environment hints for future agent runtime support.
  - GitHub via `NITELY_GITHUB_TOKEN`, `GITHUB_TOKEN`, or authenticated `gh`.
  - Google Drive via existing environment-based connector configuration.
- Never ask users to type ChatGPT, Claude, GitHub, or Google passwords into the
  Web Console.
- Keep the CLI behavior compatible.

## User Experience Requirements

- The first screen must be the actual console, not a marketing landing page.
- Use a quiet operational interface optimized for scanning repeated work:
  task list, run status, stage status, and connection health.
- Provide clear empty states for no tasks, no runs, and missing provider
  configuration.
- Text must not overflow in task rows, run cards, log panes, buttons, or forms.
- Use responsive layouts that work on desktop and mobile.

## API Requirements

The Web Console must expose local HTTP endpoints for:

- `GET /api/tasks`
- `POST /api/tasks`
- `GET /api/tasks/:taskId`
- `POST /api/tasks/:taskId/runs`
- `GET /api/runs`
- `GET /api/runs/:runId`
- `GET /api/providers`

The server must validate inputs with existing project patterns, return JSON
errors, and avoid exposing secret values.

## Non-Goals

- Multi-user authentication.
- Cloud deployment architecture.
- OAuth browser login.
- GitHub App installation.
- Storing provider secrets through the UI.
- Real-time websockets.
- Full run resume UI.
- Editing generated PR branches from the browser.

## Acceptance Criteria

1. `pnpm dev -- web --repo .` or an equivalent command starts the Web Console.
2. A user can create a task with spec and tech design text from the browser.
3. The task persists under `.nitely/tasks` and survives process restart.
4. A user can start a Nitely run for a task from the browser.
5. The UI lists tasks and runs using local persisted state.
6. The run detail page shows completed stages, branch, worktree path, inputs,
   change request URL, and available logs/evidence.
7. Provider settings show configured/missing state without leaking secret
   values.
8. Existing CLI tests continue to pass.
9. New tests cover task persistence, API validation, provider status redaction,
   and Web Console rendering or route behavior.

