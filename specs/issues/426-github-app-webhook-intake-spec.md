# Issue 426: GitHub App Webhook Intake And Governed Callbacks

GitHub issue: https://github.com/Instask/nitely/issues/426

## Problem

Nitely can fetch a GitHub issue when an operator starts planning and can scan
pull-request comments, but GitHub cannot activate Nitely through an authenticated,
event-driven boundary. Polling leaves delivery authentication, replay handling,
repository permissions, source provenance, and acknowledgement behavior outside
the governed task model.

## User-visible behavior

- An operator configures one webhook secret, an explicit GitHub repository to
  local-repository mapping, allowed actors, a trigger label, and a requested
  Flow path.
- A fresh, correctly signed `issues:labeled` delivery for the configured label
  is accepted quickly with HTTP 202 and durably queued before the response.
- Configured `issues:assigned` and issue `issue_comment:created` mention
  deliveries follow the same approval-gated draft-task path.
- Configured `pull_request_review_comment:created` deliveries create a pending
  same-PR task rework request linked to the existing completed task, prior run,
  branch, and PR; operator confirmation is still required before a rework run.
- Asynchronous processing creates or recovers one delivery-derived draft Nitely
  task backed by the existing GitHub issue source snapshot. Existing spec and
  technical-design approval requirements still gate execution; a webhook never
  starts a run.
- The task and durable intake record retain delivery, installation, repository,
  actor, event, source URL, immutable snapshot hash, and requested-Flow
  provenance.
- Redelivery of the same delivery id, event, and payload is acknowledged without
  creating another task, including after the Web process restarts. Reuse of the
  delivery id with a different event or payload fails closed.
- A bounded status-publisher seam can create or update one acknowledgement for
  the delivery without copying issue body text into comments. Callback failure
  is recorded without undoing a successfully created task.

## In scope

- HMAC-SHA256 validation over the exact request bytes.
- A configurable freshness window for supported issue events, using the signed
  issue `updated_at` timestamp because GitHub does not send a delivery timestamp
  header.
- A strict one-megabyte body limit, bounded provider identifiers, and safe
  delivery-id validation.
- Durable delivery records with atomic first-writer-wins creation and restart
  recovery for queued or interrupted processing.
- Typed normalization of `issues:labeled`, configured `issues:assigned`, and
  configured issue mentions into GitHub execution requests.
- Typed normalization of configured PR review comments into same-PR task rework
  requests.
- Explicit repository mapping, allowed-actor checks, optional installation-id
  allowlisting, trigger-label, trigger-assignee, and trigger-mention checks.
- Existing draft task, generated draft spec, source snapshot, repository Flow
  validation, and approval behavior.
- A small unauthenticated Web route whose authentication is the webhook HMAC.
- Environment configuration for a production Web process.
- Optional GitHub App status publication that exchanges a short-lived
  installation token, writes one bounded issue/PR comment, and creates/updates
  one Check Run for PR review-comment rework deliveries with a head SHA.

## Out of scope

- Free-form conversation as task or execution state.
- Automatically approving planning artifacts, starting a run, merging, or
  deploying.
- GitHub App installation/OAuth onboarding or a hosted control plane.
- Retaining the complete GitHub payload or any webhook secret.

## Functional requirements

1. The endpoint accepts only `POST /api/github/webhooks` when webhook intake is
   configured.
2. After enforcing the body-size limit, verification compares
   `X-Hub-Signature-256` to an HMAC-SHA256 of the exact raw body using a
   timing-safe comparison. Missing, malformed, or invalid signatures return 401
   before untrusted delivery/event headers are validated and create no delivery
   record.
3. `X-GitHub-Delivery` must be a bounded, path-safe identifier. The supported
   source timestamp must be no older than the configured maximum and no more than
   the allowed clock skew in the future.
4. The normalized activation request uses `nitely.dev/github-webhook/v1`,
   `kind: ExecutionRequest`, and a delivery-derived idempotency key. It contains
   received/event times, installation id, repository id/full name/URL, actor
   id/login, GitHub event/action, issue number/URL, requested Flow, immutable
   source snapshot, and SHA-256 snapshot fingerprint. The normalized PR review
   request uses `kind: ReworkRequest`, stores bounded PR/comment metadata, and
   uses a comment-derived idempotency key.
5. Repository, actor, installation, event/action, and trigger policy is
   evaluated before a runnable queue item can be created. Authenticated but
   unsupported events are durably marked ignored; denied supported events are
   durably marked denied and return 403.
6. Delivery creation is exclusive. A matching event/body duplicate returns 202
   with `duplicate: true`; a delivery-id collision with a different event or
   payload returns 409, including in the atomic concurrent-creation path.
7. The response does not await task creation or status publication. Queued and
   interrupted records are drained asynchronously and again after restart.
8. Processing creates a delivery-derived deterministic draft task in the mapped
   local repository, preserving the webhook provenance in `TaskSourceRecord`.
   Recovery reuses it only when repository, Flow, source snapshot, provenance,
   and draft approval state all match, and rematerializes execution inputs
   before completing the delivery. PR review comment processing locates the
   completed task for the same GitHub PR and creates or reuses one pending task
   rework request with prior-run and branch/PR lineage.
9. Status updates contain only provider-controlled state, delivery id, source
   URL, task id/path, and a bounded sanitized failure code. They never include
   the issue title/body or secret values.
10. Queue and callback failures are recorded durably with bounded generic error
    messages. Existing task/run approval behavior is unchanged.
11. Omitting the optional installation-id allowlist skips only that policy
    check; explicit repository mapping and actor allowlisting remain mandatory.

## Acceptance checks

1. An invalid signature returns 401 and leaves no delivery file.
2. A correctly signed stale `issues:labeled` event is rejected.
3. Re-instantiating the intake service and redelivering the same id/payload
   reports a duplicate and does not create another task.
4. An unsupported authenticated event is acknowledged as ignored and cannot
   create a task.
5. A supported event from a denied repository, actor, or installation returns
   403 and is durably non-runnable.
6. Valid configured label, assignment, and issue-mention events return 202
   before a blocked callback completes, then create one draft task with full
   provenance and invoke the bounded status-publisher seam.
7. A valid configured PR review comment creates one pending same-PR task rework
   request and publishes only bounded callback metadata.
8. Configured GitHub App callbacks request installation tokens scoped to the
   webhook repository and required Checks/issues/PR permissions, reuse cached
   tokens until the refresh window, create/update one bounded comment, and
   create/update one PR Check Run when a PR head SHA is available.
9. Multiple drain processes sharing one state directory cannot concurrently
   process or republish the same delivery; expired delivery leases are
   reclaimable after worker death.
10. Targeted webhook and Web-route tests, TypeScript check, and production build
   pass.
