# Repository Scope Web Console Spec

## Problem

The Web Console currently treats the server `--repo` as the only repository. This hides repository identity in task and run lists and makes it impossible to create or start work for another local repository from the same console.

## Goals

- Keep existing `nitely web --repo <path>` single-repo usage working.
- Add a Web Console repository registry with stable ids, display names, and local paths.
- Persist repository ids on newly created tasks and work items.
- Expose repository identity on task and run API responses.
- Let the New task panel choose a repository when more than one repository is configured.
- Start a task or work item against its repository path, not always the server home repo.
- Display legacy tasks and runs that lack repository metadata under the default repository.

## Non-Goals

- Cloning or registering remote repositories from the browser.
- Multi-tenant repository authorization.
- Cross-machine scheduling.

## Acceptance Criteria

1. `GET /api/repositories` returns at least the default repository derived from `--repo`.
2. `nitely web --repo <path> --repository <id>=<path>` registers additional local repositories.
3. `POST /api/tasks` accepts `repoId` and persists it on the task record.
4. Task and run list/detail API responses include `repoId`, `repoName`, and `repoPath`.
5. Starting a task routes `runFlow` to the repository selected for that task.
6. Existing tasks and runs without repository metadata are displayed as `default`.
7. The Web Console task list, task detail, run list, run detail, and New task form show repository identity.
8. Tests cover default compatibility and multi-repo task/run routing.
