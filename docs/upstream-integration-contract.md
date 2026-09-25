# Upstream Intake And Result Contract

Status: proposed adapter contract. This document defines the payload
boundary future GitHub, Linear, Jira, or Agent-workforce adapters should use. It
does **not** claim that Nitely currently exposes a public webhook, callback
dispatcher, or hosted control plane.

## Purpose

Nitely should consume approved work from the system a team already uses, run a
governed Flow in the customer's environment, and return a small result envelope:

```text
upstream work item -> Nitely Flow -> PR + evidence or actionable blocker
```

The contract keeps planning/workforce concerns upstream and execution evidence
inside Nitely. GitHub issues and Jira tickets are concrete local planning-input
mappings; future execution-request adapters should translate into the same
versioned envelopes instead of adding provider fields to the run model.

## Contract Principles

- **Versioned:** reject unknown major versions instead of guessing.
- **Idempotent:** repeated delivery of the same request must resolve to the same
  accepted task/run or the same terminal conflict.
- **Approved and bounded:** the adapter chooses an allowed repository, work-item
  type, Flow, and declared input artifacts; it does not submit an open-ended
  chat assignment.
- **Reference-first:** inputs and evidence use immutable or revision-pinned
  references where possible. Large source, logs, prompts, and artifact bytes do
  not travel in callback payloads.
- **Customer-controlled:** adapters run at the customer's trust boundary. A
  future hosted control plane must not require raw source, prompts, logs, or
  secrets in this envelope.
- **Authenticated and allow-listed:** callback destinations and credentials are
  local configuration references, never inline secret values.

## Execution Request V1

```json
{
  "apiVersion": "nitely.dev/integration/v1",
  "kind": "ExecutionRequest",
  "idempotencyKey": "github:acme/app:issue:397:2026-07-13T16:47:02Z",
  "source": {
    "type": "github.issue",
    "url": "https://github.com/acme/app/issues/397",
    "repository": {
      "host": "github.com",
      "owner": "Instask",
      "name": "nitely"
    },
    "number": 397,
    "revision": {
      "updatedAt": "2026-07-13T16:47:02Z"
    }
  },
  "execution": {
    "repositoryId": "default",
    "workItemType": "dev.pr",
    "flow": "pilot-approved-spec-pr",
    "approval": {
      "state": "approved",
      "actor": "github:octocat",
      "at": "2026-07-13T17:00:00.000Z",
      "artifactIds": ["spec", "tech-design"]
    },
    "inputs": [
      {
        "id": "source",
        "mediaType": "application/json",
        "uri": "snapshot://github/acme/app/issues/397/2026-07-13T16:47:02Z"
      },
      {
        "id": "spec",
        "mediaType": "text/markdown",
        "uri": ".nitely/tasks/task-397/spec.md",
        "sha256": "sha256:<hex>"
      },
      {
        "id": "tech-design",
        "mediaType": "text/markdown",
        "uri": ".nitely/tasks/task-397/tech-design.md",
        "sha256": "sha256:<hex>"
      }
    ]
  },
  "callback": {
    "url": "https://engineering.example.test/nitely/results",
    "events": ["blocked", "terminal"],
    "auth": {
      "type": "bearer-reference",
      "secretRef": "env://NITELY_RESULT_CALLBACK_TOKEN"
    }
  }
}
```

### Required fields

| Field | Rule |
| --- | --- |
| `apiVersion` | Exactly `nitely.dev/integration/v1` for this contract. |
| `kind` | Exactly `ExecutionRequest`. |
| `idempotencyKey` | Stable for one upstream item revision and intended execution. Maximum 256 characters. |
| `source.type` | `github.issue` in the first adapter; future adapters add namespaced values. |
| `source.url` | Canonical upstream work-item URL. |
| `source.repository` | Exact GitHub host, owner, and repository identity. |
| `source.number` | Positive GitHub issue number. |
| `source.revision.updatedAt` | Revision pin used when a provider has no immutable content digest. |
| `execution.repositoryId` | Existing allow-listed Nitely repository identifier. Never an arbitrary filesystem path from the request. |
| `execution.workItemType` | Flow-compatible work-item type, normally `dev.pr`. |
| `execution.flow` | Existing built-in or repository-approved Flow name. |
| `execution.approval` | Explicit approved state, policy-recognized actor, decision time, and the approved artifact ids. The adapter verifies the actor may approve this repository/work-item type. |
| `execution.inputs` | Unique declared artifact ids with media type and adapter-materialized URI. |

`callback` is optional. If present, the adapter must resolve `secretRef` locally,
require HTTPS outside explicit development mode, and enforce a destination
allow-list. `secretRef` identifies a credential; the referenced secret value is
never serialized into task, run, event, evidence, or callback records.

The `snapshot://` URI in the example is an adapter-owned immutable reference,
not a connector currently accepted by the Nitely CLI. Before creating a task,
the adapter materializes that snapshot into the existing local task/source
artifact boundary and records its origin metadata.

## Idempotency Semantics

The adapter persists the tuple `(apiVersion, idempotencyKey, normalized
request digest)` before starting a run:

- the first valid request creates or selects one task and one execution;
- an identical replay returns the existing task/run identity and current state;
- the same key with a different normalized digest is a conflict and starts
  nothing;
- retrying result delivery never starts or resumes a Nitely run;
- a new upstream revision uses a new key and may create a deliberate rework run
  against the existing change request.

## Execution Result V1

```json
{
  "apiVersion": "nitely.dev/integration/v1",
  "kind": "ExecutionResult",
  "eventId": "run-01J2-example:42",
  "sequence": 42,
  "idempotencyKey": "github:acme/app:issue:397:2026-07-13T16:47:02Z",
  "occurredAt": "2026-07-14T01:00:00.000Z",
  "taskId": "task-397",
  "runId": "run-01J2-example",
  "status": "completed",
  "changeRequest": {
    "provider": "github",
    "url": "https://github.com/acme/app/pull/398",
    "number": 398,
    "baseBranch": "master",
    "headBranch": "nitely/run-01J2-example",
    "draft": true,
    "outcome": "created"
  },
  "evidence": [
    {
      "id": "run-evidence",
      "mediaType": "text/markdown",
      "uri": ".nitely/runs/run-01J2-example/evidence.md",
      "sha256": "sha256:<hex>"
    }
  ]
}
```

### Status values

| Status | Meaning | Required result fields |
| --- | --- | --- |
| `accepted` | Request passed adapter validation and has durable identity. | `taskId`; `runId` when allocated. |
| `running` | A run is actively executing or awaiting an internal gate. | `taskId`, `runId`. |
| `blocked` | Operator action or an external condition is required. | `taskId`, `runId`, `blocker`. |
| `completed` | The requested Flow reached its terminal successful state. | `taskId`, `runId`, evidence; `changeRequest` for PR-producing Flows. |
| `failed` | The Flow reached a terminal failure. | `taskId`, `runId`, sanitized error summary, evidence when available. |
| `cancelled` | An authorized operator cancelled the run. | `taskId`, `runId`, evidence when available. |

A blocked result uses a bounded summary:

```json
{
  "status": "blocked",
  "blocker": {
    "reason": "awaiting_operator_answer",
    "stageId": "implement",
    "questionId": "implement-1",
    "retryAfter": null,
    "message": "A sanitized operator-facing summary"
  }
}
```

Allowed blocker fields are `reason`, `stageId`, `questionId`, `retryAfter`, and
a redacted `message`. The callback must not include raw provider stderr, prompts,
source excerpts, secrets, or unrestricted artifact content.

## Result Delivery

- `eventId` is globally stable for one emitted result; receivers deduplicate it.
- `sequence` increases within a run so receivers can ignore stale delivery.
- Delivery uses `POST` with `content-type: application/json` and the locally
  resolved callback authorization value.
- Non-2xx responses use bounded exponential retry. Retries preserve `eventId`
  and payload bytes.
- Redirects are rejected unless the redirected host is separately allow-listed.
- A terminal callback is immutable. Later same-PR rework is a new run and emits
  a result with its own `runId` and `changeRequest.outcome: "updated"`.

## GitHub-First Mapping

| GitHub concept | Nitely mapping |
| --- | --- |
| Issue URL, owner/repo, number, updated time | `source` identity and revision. |
| Issue title/body/labels | Sanitized source snapshot materialized under the task directory. |
| Approved spec and technical design | Declared `spec` and `tech-design` input artifacts. |
| Repository installation/configuration | Allow-listed `execution.repositoryId`; never request-controlled disk path. |
| Flow selection | Repository policy chooses an allowed Flow; labels may suggest but must not bypass policy. |
| Draft pull request | `changeRequest` result plus evidence reference. |
| Issue comment/check/status update | Adapter-specific rendering of the same `ExecutionResult`; not core run state. |
| Reviewer feedback | A new idempotent rework request tied to the existing PR and prior run. |

The shipped Jira planning adapter normalizes ticket identity, revision, comments,
attachment metadata, and linked issues into the same local task source boundary
as GitHub intake. A future Jira execution-request or callback adapter should
translate the approved task into this envelope. Linear and Multica-like systems
should follow the same rule; none of them change Flow, run, artifact, blocker,
or evidence semantics.

## Current Implementation Boundary

Nitely currently has local/Web task creation, normalized GitHub issue and Jira
ticket snapshot ingestion, duplicate prevention, source-drift refresh, optional
idempotent Jira status comments, GitHub draft PR publication,
PR-comment-triggered rework, run projection, and evidence generation. These are
customer-controlled local integrations, not the public `ExecutionRequest`
endpoint described above. A production execution-request adapter still needs
durable request-key storage, endpoint authentication, repository/Flow policy
resolution, callback delivery, and retry observability. Those capabilities
should be implemented in a dedicated issue before that public adapter is
advertised as available.
