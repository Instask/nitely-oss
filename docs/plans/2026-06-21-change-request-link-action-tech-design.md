# Issue 78 Tech Design: Change Request Link Action

## Approach

Fix the bug entirely in the Design Component console template and view model. The backend already exposes `changeRequestUrl` in run summaries and details, and the run detail view model is built from the full run detail object. No API changes are needed.

## UI Changes

- Replace the run detail `View {{ selectedRun.cr }}` button with an anchor.
- Bind `href` to a view-model field that contains the exact `changeRequestUrl`.
- Keep the existing primary action styling so the header layout does not change.
- Add `target="_blank"` and `rel="noopener noreferrer"` for external navigation.
- Keep `onClick="{{ stop }}"` to avoid accidental parent handlers if this action is reused or moved.

## View Model

Add a small formatter for change request labels:

- GitHub PR URL: `#<number>`.
- Other URL: `change`.
- Missing URL: empty string.

Expose `selectedRun.changeUrl` and `selectedRun.cr` in the run detail model. `selectedRun.hasChange` remains the condition that controls visibility.

## Tests

Extend `test/web/console-static.test.ts` with a static assertion that the run detail template:

- contains an anchor href bound to `selectedRun.changeUrl`;
- opens in a new tab with safe `rel`;
- no longer renders the run detail action as a `noop` button.
