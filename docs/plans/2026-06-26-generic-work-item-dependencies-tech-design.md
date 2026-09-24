# Generic Work Item Dependencies Tech Design

## Approach

Extend the generic work-item persistence path rather than adding a parallel dependency model. Legacy tasks already have `priority`, `dependsOn`, and `suggestedDependencies`; generic `WorkItemRecord` has the fields but creation and update patches do not admit them.

## Data Model

- Reuse `TaskPriority` and `SuggestedDependency`.
- Normalize priority to `P2` when omitted or invalid.
- Normalize `dependsOn` to unique non-self ids.
- Normalize suggested dependencies to structurally valid records.

## API

- `/api/work-items` passes `priority`, `dependsOn`, and `suggestedDependencies` into `createFlowWorkItem`.
- Existing `/api/tasks/:id/dependencies` routes become unified routes in behavior while keeping the URL stable for the console.
- Mutations first try the generic work-item store, then fall back to legacy task helpers.

## Graph Behavior

- Dependency readiness and cycle checks use `listUnifiedWorkItems`.
- Existing scheduler graph/view code already reads `dependsOn` and `suggestedDependencies`, so API/store support is enough for generic DAG edges to appear.

## Tests

- Web API test for create-time priority/dependencies and scheduler edge projection.
- Web API test for mixed legacy/generic dependency add, cycle rejection, and removal.
