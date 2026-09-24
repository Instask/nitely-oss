# Planning Intake

Nitely accepts one planning source as intake and governs everything after it.
Intake never skips a gate: a source becomes a draft Task, a draft spec, a human
approval, a repository-grounded draft technical design, a second human
approval, and only then an implementation Run.

This document is the contract shared by the Web Console, the CLI, and the HTTP
API. All three drive the same state machine on the same Task record.

## Intake sources

| Source | `sourceType` | Required payload |
| --- | --- | --- |
| GitHub issue | `github-issue` | `issue` (issue URL) |
| Jira ticket | `jira-ticket` | `issue` (browse URL or key) |
| External document | `external-document` | `documentUrl`, `text` |
| Prompt | `prompt` | `prompt`, or `conversation` with an operator turn |
| Pasted text | `text` | `text` |

Every source is submitted to `POST /api/draft-specs`. No caller supplies a spec
or a technical design to create a Task. The artifact-first `POST /api/tasks`
path still exists for callers that already hold approved markdown.

Optional on any source: `title`, `guidance`, `repoId`, `flowPath`, `templateId`.

## External documents are a connector boundary

`external-document` is provider-neutral on purpose. Nitely does not fetch the
document, does not hold a Lark/Feishu, Confluence, or Google Docs credential,
and does not encode any provider's workflow in the Task model. A connector, a
script, or an operator fetches the document and pushes what Nitely governs:

```json
{
  "sourceType": "external-document",
  "documentUrl": "https://example.feishu.cn/docx/ABC123",
  "documentVersion": "rev-42",
  "title": "Nightly release policy",
  "text": "Every release must publish a draft PR that links back to run evidence."
}
```

Nitely normalizes that into durable provenance:

- The URL must be absolute `http`/`https`. URLs that embed credentials are
  rejected, query parameters whose names read as secrets are dropped, and the
  fragment is removed so one document converges on one Task.
- `documentExternalId` is honored when a connector owns document identity;
  otherwise the id is derived from the URL's host and path.
- `text` becomes the snapshot body. It is required: a source with no snapshot
  cannot be reviewed, hashed, or drift-checked.
- `documentVersion` is stored as the provider revision when the provider has
  one, and is compared during drift checks.

## Conversation intake

A rough prompt can arrive as a short planning conversation instead of a single
sentence:

```json
{
  "sourceType": "prompt",
  "conversation": [
    { "role": "operator", "text": "Operators should paste a GitHub URL to import." },
    { "role": "agent", "text": "Which providers does the first slice cover?" },
    { "role": "operator", "text": "GitHub only, and reject duplicate URLs." }
  ]
}
```

The turns are persisted on the Task as `source.conversation` with a summary and
a recorded timestamp, and are rendered into the draft spec under
**Conversation Intake** as history rather than as approved requirements. When no
explicit `prompt` is given, the operator turns become the intake summary the
draft spec is generated from. Conversations are capped at 50 turns, 8,000
characters per turn, and 40,000 characters in total.

Conversation intake is not a chat product. It records what a human already
decided so the planning trail can be audited; it does not run a dialogue loop.

## Source provenance, snapshots, and hashes

Every snapshot-backed source stores `source.snapshot` with the fetched title,
body, timestamps, provider fields, and a `contentHash`. The hash is a SHA-256
digest over the snapshot's comparable fields — URI, external id, title, body,
version, state, participants, labels, comments, attachments, and linked issues.
`fetchedAt` is excluded, so re-reading an unchanged source produces the same
hash.

The hash makes the approved baseline checkable: the Task carries the snapshot
planning was approved against, and any later snapshot can be compared to it
without re-deriving the comparison rules.

## Drift cannot silently invalidate an approved baseline

Submitting the same GitHub issue, Jira ticket, or document URL again reuses the
existing Task instead of creating a duplicate. Nitely compares the new snapshot
to the approved baseline and records `source.drift`:

- `status: "unchanged"` — nothing to do.
- `status: "changed"` — the changed field names and the latest snapshot are
  stored on the Task, the response reports
  `ingestion: { reused: true, driftStatus: "changed" }`, and the run gate
  refuses to start: *source issue changed since planning; refresh planning or
  start with override=true*.

The stored baseline is never overwritten by the drifted snapshot. Two ways
forward:

- `POST /api/tasks/<task-id>/refresh-source-planning` (CLI:
  `nitely task refresh-source-planning <task-id>`) regenerates the draft spec
  from the latest snapshot and returns the Task to `draft`, which re-opens both
  approval gates.
- An explicit operator override accepts the drift for one manual Run and is
  recorded with actor and reason. Automatic scheduling never overrides drift.

## Approval gates

The gates are identical on every surface:

1. Intake creates the Task with `status: "draft"` and `specStatus: "draft"`.
2. `approve-spec` requires source-specific requirements: a generated draft whose
   FR/SC placeholders are untouched is refused.
3. `draft-tech-design` requires an approved spec and generates a design grounded
   in the repository — package scripts, source and test layout, docs, specs, and
   flows — with open questions persisted on the Task.
4. `approve-tech-design` requires a generated draft design; there is no
   placeholder to approve.
5. A Run starts only when both artifacts are approved and no drift, spec
   readiness, dependency, governance, or preflight blocker remains.

## Auditability without provider secrets

What intake persists: the source type, URL, external id, provider revision, the
snapshot and its hash, drift state and changed fields, conversation turns,
planning guidance, and every approval decision with its actor and timestamp.

What intake never persists: provider tokens, cookies, or authorization headers.
Ticket credentials stay in the customer-owned provider store or the process
environment, external documents are pushed rather than fetched, and
credential-bearing URLs are rejected before they reach the Task record.
