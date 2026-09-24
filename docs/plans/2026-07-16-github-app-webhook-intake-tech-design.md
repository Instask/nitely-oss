# GitHub App Webhook Intake First-Slice Technical Design

Spec: [specs/issues/426-github-app-webhook-intake-spec.md](../../specs/issues/426-github-app-webhook-intake-spec.md)

## Goal

Add a production-usable, fail-closed GitHub webhook boundary for one narrow
activation event while reusing Nitely's existing GitHub issue snapshot and
approval-first task model. The HTTP path performs bounded validation and one
durable enqueue write; task creation and callbacks happen after the response.

## Architecture

Create a focused `src/github-webhooks/` module with three responsibilities:

1. **Authentication and normalization** verifies exact bytes, validates
   delivery identity and freshness, parses only the fields required for an
   immutable `issues:labeled` execution request, and applies repository/actor/
   installation/label policy.
2. **Durable delivery store** writes
   `.nitely/github-webhooks/deliveries/<delivery-id>.json` with an exclusive
   temporary file and hard link so the first authenticated event/body pair
   wins. File data and the containing directory are synced before acceptance;
   atomic replacements update state. The event and body hash detect a
   delivery-id collision. No request headers, webhook secret, or complete
   upstream payload are stored.
3. **Single-process drain** reclaims `queued` and `processing` records, creates
   or recovers a delivery-derived deterministic draft task in the mapped
   repository, records the task id, and calls an optional bounded status
   publisher. A serialized drain avoids same-process races. Recovery validates
   the complete immutable lineage and draft approval state, then rematerializes
   execution inputs to close the crash window between task creation and delivery
   completion.

`src/web/server.ts` receives a small early route integration. `startWebServer`
constructs one intake runtime from explicit input or environment configuration,
starts recovery without blocking listen, and schedules a drain only after the
202 response is written.

Delivery processing uses a per-delivery lease file next to the durable delivery
record. A worker creates the lease with exclusive file creation before it marks a
record `processing`, retries a failed callback, or publishes final status. Other
workers skip the delivery while the lease is valid. If a Web process dies, a
later worker can reclaim the delivery after the lease expires and continue from
the durable `queued`, `processing`, `completed` plus failed-callback, or `failed`
state.

## Configuration

The programmatic configuration carries:

```ts
interface GitHubWebhookConfiguration {
  secret: string;
  repositories: Array<{ fullName: string; repositoryId: string }>;
  allowedActors: string[];
  allowedInstallationIds?: number[];
  triggerLabels?: string[];
  triggerAssignees?: string[];
  triggerMentions?: string[];
  flowPath: string;
  reworkFlowPath?: string;
  maxDeliveryAgeMs?: number;
  maxFutureSkewMs?: number;
  statusPublisher?: GitHubWebhookStatusPublisher;
  now?: () => Date;
}
```

The Web command can enable the same boundary without putting a secret on the
command line:

- `NITELY_GITHUB_WEBHOOK_SECRET`
- `NITELY_GITHUB_WEBHOOK_REPOSITORIES=owner/repo=local-repository-id[,..]`
- `NITELY_GITHUB_WEBHOOK_ACTORS=login[,..]`
- `NITELY_GITHUB_WEBHOOK_INSTALLATIONS=123[,..]` (optional)
- `NITELY_GITHUB_WEBHOOK_LABELS=nitely[,..]` (default `nitely`)
- `NITELY_GITHUB_WEBHOOK_ASSIGNEES=nitely-bot[,..]` (optional)
- `NITELY_GITHUB_WEBHOOK_MENTIONS=@nitely[,..]` (optional)
- `NITELY_GITHUB_WEBHOOK_FLOW=flows/implement-spec-bootstrap.json`
- `NITELY_GITHUB_WEBHOOK_REWORK_FLOW=flows/rework-pr-bootstrap.json`
- `NITELY_GITHUB_WEBHOOK_MAX_AGE_MS` (optional)
- `NITELY_GITHUB_APP_ID` (optional; enables GitHub App callback publisher with
  a private key)
- `NITELY_GITHUB_APP_PRIVATE_KEY` or
  `NITELY_GITHUB_APP_PRIVATE_KEY_BASE64` (optional; set exactly one)
- `NITELY_GITHUB_API_BASE_URL` (optional; defaults to GitHub.com REST API)
- `NITELY_GITHUB_WEBHOOK_STATUS_BASE_URL` (optional; used for task detail links)
- `NITELY_GITHUB_WEBHOOK_CHECK_NAME` (optional; defaults to `Nitely`)

If any required setting is missing, the route remains unavailable. Configuration
parsing fails closed during server startup rather than silently broadening an
allowlist. The installation list is the sole optional allowlist: omitting it
skips the installation-id check, while repository mapping and actor allowlisting
remain mandatory.

## Typed request and persistence

The stored execution request is versioned and contains:

- `apiVersion: nitely.dev/github-webhook/v1`, `kind: ExecutionRequest`, and a
  stable delivery-derived idempotency key;
- delivery/received/event timestamps and requested Flow;
- installation id;
- repository id/full name/URL and mapped Nitely repository id;
- actor id/login;
- GitHub event/action and issue number/URL;
- the existing `TaskSourceSnapshot` shape populated only from signed payload
  fields; and
- a canonical SHA-256 fingerprint of the snapshot.

Configured `issues:assigned` and issue mention events use the same
`ExecutionRequest` shape. Configured `pull_request_review_comment:created`
events use a sibling `ReworkRequest` shape that stores bounded PR/comment
metadata, a comment-derived idempotency key, and the rework Flow. Processing
finds the existing completed task by GitHub PR URL and creates a pending
`TaskReworkRequest`; it does not confirm or start the rework run.

This local webhook envelope deliberately does not claim conformance with the
approved-input `nitely.dev/integration/v1` contract. Activation events create a
draft planning task; its spec and technical design still require approval before
Nitely can form an approved execution request or start a run.

The delivery record state is `queued`, `processing`, `completed`, `failed`,
`ignored`, or `denied`. Authenticated unsupported and denied deliveries get a
minimal durable record so redelivery cannot change their decision. Invalid
signatures never reserve a delivery id.

## Existing behavior reused

- `generateDraftSpec` converts the normalized issue source into a reviewable
  draft without granting approval.
- `createTask` validates the repository-owned Flow path, materializes immutable
  source inputs, and preserves the normal spec/technical-design approval gates.
- `TaskSourceRecord` gains one optional webhook provenance field; existing task
  records and non-webhook intake remain backward compatible.
- Repository registry resolution ensures the external allowlist maps to an
  explicitly managed local repository.

## Callback boundary

The status publisher receives a discriminated update with `task-created`,
`rework-request-created`, or `failed`. Each update is capped to fixed identifiers
and URLs. No issue body, reviewer instruction, title, arbitrary exception, or
webhook secret crosses the seam. Implementations can use a stable delivery marker
to create/update one GitHub issue or PR comment.

When the GitHub App publisher is configured, it generates a GitHub App JWT,
exchanges it for a short-lived installation token scoped to the webhook
repository id, and requests only `checks:write`, `issues:write`, and
`pull_requests:write`. It creates or updates one bounded issue/PR comment for
each delivery. For PR review-comment rework deliveries, where the webhook
contains a PR head SHA, it also creates or updates one Check Run using
`external_id: github-webhook:<delivery-id>`. GitHub issue activations do not have
a commit SHA, so they publish a bounded issue comment but no Check Run.

Returned GitHub check/comment ids are persisted in the delivery callback record
and passed back on retry so a restarted Web process updates the same external
objects instead of blindly creating duplicates.

Publisher failure is best effort: the task remains authoritative and the
delivery records a bounded callback failure for later retry/inspection.

## Multi-process lease boundary

Leases are local filesystem claims under
`.nitely/github-webhooks/deliveries/<delivery-id>.json.lock`. They include an
owner id, random token, acquisition time, and expiry time. The lease protects the
delivery drain critical section, not the broader scheduler. It prevents multiple
Web processes from processing the same queued delivery or retrying the same
callback concurrently while still allowing stale recovery after worker death.

## TDD plan

1. Add module tests for invalid HMAC, stale delivery, durable duplicate after
   service re-instantiation, unsupported event, repository/actor/installation
   denial, normalization provenance, processing recovery, and callback bounds.
2. Run the tests and retain the expected missing-module RED evidence.
3. Implement the minimum authentication, normalization, store, and processor to
   make module tests green.
4. Add a Web-route integration test that holds the callback open and proves the
   HTTP 202 response arrives first, then verifies the persisted task.
5. Run that test to RED before adding the route/runtime integration.
6. Add environment parsing tests, observe RED, then wire startup configuration.
7. Run targeted tests, the complete relevant Web regression file if practical,
   `pnpm check`, and `pnpm build`.
8. Add hardening regressions for route-level 413 handling, authentication order,
   concurrent event collision, bounded provider identifiers, complete task
   lineage, partial materialization recovery, and empty issue bodies.

## Failure handling and security

- Signature comparison is timing-safe and uses the exact raw body.
- The body-size limit is enforced before authentication; exact-body
  authentication then precedes validation of untrusted delivery/event headers.
- Provider identifiers that can reach persistence or callbacks are bounded
  before policy evaluation.
- Future and stale timestamps fail closed for supported events.
- Repository and actor comparisons are normalized and never wildcarded; a
  configured installation list is normalized and enforced, while omission
  intentionally skips only that check.
- Exclusive creation prevents a concurrent duplicate from replacing the first
  event/body pair; event or body-hash mismatch is a conflict.
- Queue files use mode 0600, synced file data, synced directory entries, and
  atomic rename. Persisted errors use a small code/message allowlist rather than
  upstream or thrown text.
- The processor never starts a run. Existing human approval remains mandatory.

## Rollout and rollback

The feature is disabled unless explicitly configured. Rollout can begin on one
repository, actor list, installation, label, assignee, or mention. Remove the
environment settings and restart Web to disable new intake while preserving
delivery/task evidence.
Rollback is a code revert; existing optional task provenance and delivery files
remain readable and do not affect other task paths.

## Follow-ups

- Retention pruning.
