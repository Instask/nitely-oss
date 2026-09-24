# Tech Design: Idempotent GitHub Publish

## Overview

Make publish idempotent at the SCM provider boundary. A caller should invoke
`publishChange` once and receive a `ChangeRequest` whether the PR was newly
created or already existed for the same branch/base.

## Design

- Extend `ChangeRequest` with optional `outcome: "created" | "reused" |
  "updated"`.
- Add shared GitHub API helpers to normalize pull payloads into `ChangeRequest`
  records.
- In `GitHubScmProvider.publishChange`:
  - push the branch as today;
  - query open PRs with `head=<owner>:<headBranch>&base=<baseBranch>`;
  - if a match exists, return it with `outcome: "reused"`;
  - otherwise create a draft PR and return it with `outcome: "created"`.
- In `GitHubCliScmProvider.publishChange`:
  - push the branch as today;
  - run `gh pr list --head <branch> --base <base> --state open --json ...`;
  - if a match exists, return it with `outcome: "reused"`;
  - otherwise keep the existing `gh pr create --draft` path and return
    `outcome: "created"`.
- In update-change, return `outcome: "updated"` so the existing update path is
  distinguishable in the same metadata shape.
- In run evidence:
  - `change.published` and `change.updated` already embed `changeRequest`, so
    the optional outcome will be recorded there automatically;
  - add an explicit `Change outcome:` line to `change-request.md` when known.

## Risks

- GitHub API `head` filters need the owner-qualified branch for same-repo PRs;
  tests assert the encoded query.
- Older custom `publishChange` dependencies may not set the outcome; all
  evidence changes must remain optional.
