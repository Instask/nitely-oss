# Work coordination

Overlapping runs can otherwise publish, update, review, or repair the same
work from a snapshot that is already stale. Nitely stops that with a
repository-local gate in `.nitely/coordination.db`. The gate is code. A prompt
rule is not a claim.

Scheduler leases and run admission stay separate. This gate covers the side
effect itself: the GitHub publish or update, the same-pull-request CI repair,
and webhook wakes for one issue or pull request.

## Conflict domains

A mutation claims every domain that names the work, in one transaction:

- `action:publish`, `action:update`, `action:review`, or `action:repair`, plus the pull request, issue, or branch it targets
- the branch name
- a hash of the worktree path
- `github-issue:owner/repo#n` and `github-pr:owner/repo#n`
- a stable shared artifact id, when the caller supplies one

Stage input names such as `implementation` are not shared artifacts. They are
declared again by every run, so publish and update do not claim them.

An update and a repair of the same pull request both claim that
`github-pr` domain, so they cannot both mutate it. Two publishes of one
branch claim that branch.

## Freshness

The caller passes the shared head it observed.

- Publish observes `none`, meaning "not yet published". The first publish of a
  branch proceeds. Completing it records that branch's commit SHA. A later
  publish that still observes `none` is held. The hold includes a bounded
  delta, at most eight short lines, and does not call GitHub.
- Update observes the pull request head recorded when the run checked the
  change request out. An overlapping run that still holds the previous head
  is held. A later run whose observed head equals the recorded head may
  proceed.
- Repair observes the head used for CI-repair admission.

The same observed cursor is held once. A second proposal with that same cursor
stops at the re-evaluation limit. A proposal that observes the new cursor is
the bounded re-evaluation. The stage does not republish on its own.

An external push is visible when the run's observed head differs from the head
recorded by the last Nitely mutation of that domain. A push that no Nitely
mutation has recorded is outside this gate.

## Claims

The effect starts only after the claim is marked unknown. A completed
idempotency key replays the stored GitHub URL and head, and does not call
GitHub again. An unknown key means the effect already started; Nitely does not
guess that it failed and does not replay it. A claim held by another key
conflicts. Aborting a claim that has not started releases it.

Webhook intake records one wake per issue or pull request. A newer event
becomes the lead. An older or duplicate delivery is stored and does not create
a second task. A newer lead that arrives while the previous delivery still
holds an unexpired lease stays queued. It is not marked completed. Only the
lease owner can release that lease, and an older worker cannot clear a lease
the newer lead already took. When the owner finishes or the task creation
fails, intake drains the queue again and creates the new lead's task. The
lead's task is created before the wake is finished, so a crash in between
retries the same delivery instead of dropping it. A delivery with no wake row
is still processed. If that delivery is queued again after the wake was
finished, the lead is claimed again and the existing task is reused.

Hold, conflict, and unknown decisions are written to the attempt's
`coordination.jsonl`, copied into `evidence.md`, and appended to the run event
log. The Web Console does not render those events as a new screen. Stage
approvals and the rest of the run evidence stay in place.
