# Terminal Run Status Finalizer Separation Tech Design

## Approach

Extend run projection with explicit terminal metadata:

- `terminalStatus`
- `terminalStageId`
- `terminalEventAt`
- `finalizerStageIds`

When a terminal run event is projected, capture the latest known stage as `terminalStageId` and reset any prior finalizer tracking. This keeps resumed blocked runs compatible: a later terminal event replaces the previous terminal boundary.

After a terminal event, stage-scoped events are tracked as finalizer stages. Non-terminal updates such as approval requests must not overwrite an existing terminal run status.

## Web Projection

Web run summaries use `terminalStageId` as the main `currentStage` when present. The latest post-terminal stage is exposed through:

- `finalizerStage`
- `finalizerAttempt`
- `finalizerStageState`

The stage timeline still includes every stage, including finalizers, so operators can inspect reflection output without confusing it with the main workflow result.

## Inbox Filtering

Approval inbox listing checks approval-source notifications against the event projection for the associated run. If the run has events and its status is not `awaiting-approval`, the notification is omitted from the inbox response.

This is intentionally read-time filtering. It avoids destructive cleanup and keeps old notification files available for audit/debugging.

## Verification

- Projection tests cover failed runs followed by finalizers.
- Projection tests cover blocked runs followed by finalizer approval events.
- Web run tests cover failed publish followed by completed reflection.
- Server tests cover stale approval notifications for terminal runs.
