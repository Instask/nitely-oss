# Repository Scope Web Console Tech Design

## Architecture

Add a lightweight Web Console repository registry. The server home repo remains `StartWebServerInput.repoPath` and stores auth/provider state. A new optional `repositories` input and CLI `--repository <id>=<path>` flag add managed target repositories. The default repository is always registered as `default`.

## Data Model

Introduce `WebRepository` with `id`, `name`, `path`, and `defaultBranch`. Add optional `repoId` to `TaskRecord`, `WorkItemRecord`, and `RunFlowInput`. Run summaries/details gain `repoId`, `repoName`, and `repoPath` after server-side decoration. `runFlow` persists `repoId` in `run.created` and `run.json` when supplied.

Legacy records without `repoId` resolve to the default repository for display and routing.

## API

- `GET /api/repositories`: list configured repositories.
- Existing task/work-item create APIs accept `repoId`.
- Existing list/detail APIs aggregate tasks and runs from all registered repositories and decorate each record with repo metadata.
- Existing start APIs resolve the task/work-item first, then call `runFlow` with that repository path.

Provider credentials remain scoped to the server home repo/user in this increment.

## UI

Fetch repositories with the existing boot data. Show repository in task and run rows, task metadata, and run metadata. The New task panel renders a repository select only when multiple repositories are configured.

## Testing

Use server API tests for multi-repo behavior and CLI tests for `--repository`. Use static UI tests for the repository select and row metadata bindings.
