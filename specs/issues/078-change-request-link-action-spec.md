# Issue 78 Spec: Change Request Link Action

## Problem

The Web Console run detail view renders a primary `View <PR>` change request action when a run has `changeRequestUrl`, but the control is a button wired to `noop`. Users can see that a PR exists but cannot open it from the run detail screen.

## Goals

- Render the run detail change request action as a real link to the run's `changeRequestUrl`.
- Open the change request in a new tab or window.
- Preserve the existing visual treatment and only change the broken behavior.
- Keep the action hidden when the run has no `changeRequestUrl`.
- Use a GitHub-specific `#<number>` label for GitHub PR URLs and a generic label for other change request URLs.

## Non-Goals

- Redesign the run detail header.
- Change API response shape unless the existing view model cannot support the link.
- Add support for new SCM providers beyond URL-based linking.

## Acceptance Criteria

1. A run detail with `changeRequestUrl` renders an anchor with `href` bound to the exact URL.
2. The anchor uses `target="_blank"` and `rel="noopener noreferrer"`.
3. The action does not call `noop`.
4. GitHub pull request URLs display as `View #<number>`.
5. Non-GitHub change request URLs display a compact generic label.
6. Static console tests cover the rendered link binding.
