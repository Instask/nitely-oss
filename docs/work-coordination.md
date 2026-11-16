# Work coordination

Overlapping runs can otherwise publish, update, review, or repair the same
work from a snapshot that is already stale. Nitely stops that with a
repository-local gate in `.nitely/coordination.db`. The gate is code. A prompt
rule is not a claim.

Scheduler leases and run admission stay separate. This gate covers the side
effect itself: the GitHub publish or update, the same-pull-request CI repair,
and webhook wakes for one issue or one review comment.

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

The caller passes the instant it observed the world it is about to act on.

- Publish and update observe at the run's `run.created` event. That is when
  the run read its issue, branch, and change request target. A resumed run
  keeps that instant.
- Repair observes at the CI failure's `observedAt`, or at admission if that
  time is missing or in the future.

A domain is stale when a different run, or a different CI repair, completed a
mutation of it at or after that instant. The hold includes a bounded delta, at
most eight short lines, and does not call GitHub. A mutation that finished
before the instant is history the run already read, so a second pull request
for an issue, or a rework after an earlier rework, proceeds. A run's own
earlier mutation never holds it, so a publish followed by an update in one run
proceeds.

The same observation is held once. A second proposal from that run with the
same instant stops at the re-evaluation limit. A new run observes the newer
state, which is the bounded re-evaluation. The stage does not republish on its
own.

Heads are recorded for the delta and for replay, and are not compared. An
earlier gate compared the observed head with the head of the last Nitely
mutation. A push Nitely did not make then held every later update and repair
of that pull request, and every publish after the first for an issue was held
because publish always observed `none`. A push that lands after the run
observed the world is not this gate's to catch: update pushes without force,
so git rejects it, and that rejected push leaves an unknown claim (below).

## Claims

The effect starts only after the claim is marked unknown. A completed
idempotency key replays the stored GitHub URL and head, and does not call
GitHub again. An unknown key means the effect already started; Nitely does not
guess that it failed and does not replay it. A claim held by another key
conflicts. Aborting a claim that has not started releases it.

An unknown claim keeps every domain it claimed, including the issue and pull
request, until an operator answers for it. The conflict names its key.

```bash
nitely coordination unknown --repo <path>
```

After checking GitHub, record what happened:

- `nitely coordination resolve <key> --applied --head <sha> [--url <url>]`
  records the effect as completed. Runs that observed the world before now are
  held, and the same key replays this record.
- `nitely coordination resolve <key> --not-applied` drops the claim and frees
  its domains. That key may run its effect again.

Nitely does not expire unknown claims. A timer cannot tell a lost push from a
completed one, and a wrong guess publishes twice.

Webhook intake records one wake per issue for issue activations. A newer
activation becomes the lead. An older or duplicate delivery of that issue is
stored and does not create a second task. A pull request review comment does
not share a wake with the pull request or with any other comment. Its wake
includes the comment id. Intake coalesces a review comment only with another
delivery of that same comment. A different comment keeps its own comment id,
instruction, and delivery record. When the task already has an active rework
request, that comment stays queued until the active request is no longer
active. It is not marked coalesced, and it is not recorded as a processing
failure. A newer lead that arrives while the previous delivery still holds an
unexpired lease stays queued. It is not marked completed. Only the lease
owner can release that lease, and an older worker cannot clear a lease the
newer lead already took. When the owner finishes or the task creation fails,
intake drains the queue again and creates the new lead's task. The lead's
task is created before the wake is finished, so a crash in between retries
the same delivery instead of dropping it. A delivery with no wake row is
still processed. If that delivery is queued again after the wake was
finished, the lead is claimed again and the existing task is reused.

Hold, conflict, and unknown decisions are written to the attempt's
`coordination.jsonl`, copied into `evidence.md`, and appended to the run event
log. The Web Console does not render those events as a new screen. Stage
approvals and the rest of the run evidence stay in place.
