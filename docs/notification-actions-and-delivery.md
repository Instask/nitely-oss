# Notification Actions And Delivery

Nitely's local Approval Inbox is the authoritative notification and decision
record. External delivery is an optional mirror: a missing Slack, email, Jira,
GitHub, or webhook integration never prevents local review or execution.

## Action contract

Each notification persists two fields:

- `supportedActions`: the actions the source permits;
- `requiredReasonActions`: the subset that requires a non-empty reason.

The supported action vocabulary is:

| Action | Effect |
| --- | --- |
| `approve` | Approves a planning artifact, workflow gate, memory proposal, or proposed rework route when that source has a mutable local target. |
| `deny` | Denies a workflow gate, rejects a memory proposal, or dismisses a review item with evidence. |
| `resolve` | Resolves an informational review or blocker item without claiming a linked run recovered. |
| `request-changes` | Records required review feedback. Planning reviews create a new `changes_requested` artifact revision. |
| `override` | Dismisses a blocker or rework review with a mandatory reason. It does not resume a run by itself. |
| `cancel-run` | Appends an explicit `run.cancelled` event to a linked run that is still active or resumable. A reason is mandatory. |
| `assign` | Assigns or reassigns the reviewer through the primary action API or compatible assignment endpoint. |

Old notification files remain readable. Nitely supplies type-based action
defaults when these fields are absent.

The primary mutation API is:

```http
POST /api/notifications/:id/actions
Content-Type: application/json

{
  "action": "request-changes",
  "reason": "Describe rollback behavior."
}
```

`POST /api/notifications/:id/resolve` and
`POST /api/notifications/:id/assign` remain available for existing clients.
Both compatibility endpoints enforce the notification's declared actions and
write the same decision evidence as the primary API. The resolve endpoint only
translates its historical `approved`, `denied`, and `resolved` values; action
names such as `override` and `cancel-run` must use the primary API so they cannot
bypass required reasons or action-specific side effects.

Completed, failed, and already-cancelled runs cannot be cancelled again.
Blocked or interrupted runs are resumable states, so an operator can explicitly
turn either into a final `cancelled` decision.

## Decision evidence

For a task-linked notification, Nitely appends metadata-only decision evidence
to:

```text
.nitely/tasks/<task-id>/evidence/notification-decisions.json
```

For an existing linked run, it also appends a `notification.decision` event.
Evidence includes the actor, action, optional reason, notification and source
keys, and linked task, run, proposal, or artifact identifiers. Notification
bodies and provider credentials are not copied into decision evidence.
Assignment decisions additionally include the target reviewer identifier so
reassignment history remains reconstructable.

The task detail API exposes the task records as `notificationDecisions`.

## Delivery receipts and deduplication

Delivery is deduplicated by `sourceKey + channel`. Receipts live under:

```text
.nitely/notifications/deliveries/<sha256-source-key>/<channel>/<attempt-id>.json
```

A successful receipt prevents repeated polling or upserts from sending the same
source notification to that channel again. Before an external call, Nitely
durably records a `pending` receipt. Each source-and-channel pair has its own
owner-tagged atomic lock and receipt file, so a long-running channel cannot
block or overwrite another channel's delivery state. The lock heartbeat keeps
active delivery ownership fresh. If a process disappears during an external
call, later pollers preserve that channel's pending receipt instead of risking
an ambiguous duplicate, while other configured channels still fan out.
Attempt generations are stored independently: an owner that loses a stale-lock
takeover marks only its own pre-call generation abandoned, so it cannot replace
the takeover owner's delivered receipt.
A failed receipt retains only a safe channel-level error, attempt count, and
exponential `nextRetryAt`; a later dispatch of the same source retries it.
Credentials and raw remote errors are never persisted.

Inbox API records include their `deliveries` so the Web Console can show
sending, delivered, and retry-pending channels.

## Optional HTTP channels

No HTTP channel is enabled unless its URL is configured. URLs must use public
HTTPS, embedded credentials and obvious local/private IP targets are rejected,
redirects are not followed, and requests time out after ten seconds.

Use `NITELY_PUBLIC_BASE_URL` when a notification contains a local Web Console
path and external reviewers need an absolute link.

### Slack incoming webhook

```text
NITELY_NOTIFICATION_SLACK_WEBHOOK_URL=https://hooks.slack.example/...
NITELY_PUBLIC_BASE_URL=https://nitely.example.com
```

### HTTPS email relay

Nitely does not run an SMTP service. Configure an explicitly operated HTTPS
relay:

```text
NITELY_NOTIFICATION_EMAIL_RELAY_URL=https://mail.example.com/v1/send
NITELY_NOTIFICATION_EMAIL_TO=alice@example.com,bob@example.com
NITELY_NOTIFICATION_EMAIL_RELAY_TOKEN=<optional bearer token>
NITELY_PUBLIC_BASE_URL=https://nitely.example.com
```

### Customer webhook

```text
NITELY_NOTIFICATION_WEBHOOK_URL=https://customer.example.com/nitely/events
NITELY_NOTIFICATION_WEBHOOK_SECRET=<optional signing secret>
NITELY_PUBLIC_BASE_URL=https://nitely.example.com
```

Webhook requests include `X-Nitely-Dedupe-Key`. When a secret is configured,
`X-Nitely-Signature` contains `sha256=<hex HMAC-SHA256 of the raw JSON body>`.

## GitHub and Jira source mirrors

Ticket-source notifications are mirrored only when source status sync is
enabled and a public Nitely base URL is stored with the task source.

- GitHub uses a stable hidden marker in the source issue or published pull
  request comment and reuses the same comment if a retry occurs. PR review
  notifications target the pull request itself.
- Jira publishes a comment whose summary contains the same stable delivery
  marker.

The delivery receipt remains the local deduplication source of truth for both
channels.

## Proposal notifications

Reviewer feedback that requires approval before a rework route creates a
`review-rework` item linked to the exact source comment. Approving it from the
Inbox is consumed by the next PR-comment processing pass.

Reflection and reviewer-feedback memory proposals create `review-memory`
items linked to `/context-kg?entry=<proposal-id>`. Approve and deny update the
proposal to `approved` and `rejected`, respectively. Both proposal sources use
the same optional external delivery fan-out.
