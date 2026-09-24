# Issue 417 First Slice: Web Console Preview Panel

Follow-up completion scope is tracked in
`specs/issues/417-web-console-preview-completion-spec.md`.

## Problem

The preview runtime from #416 is available through JSON APIs, but operators have
no Web Console surface for starting sessions, seeing state transitions, running
basic interactions, or inspecting diagnostics.

## Scope

This slice adds a top-level Web Console Preview page.

In scope:

- sidebar navigation and `/preview` route;
- repository/command/route/viewport start form backed by `/api/preview-sessions`;
- session list with state badges, repository/provider, command, viewport, URL,
  and lifecycle metadata;
- controls for reload, same-origin route navigation, screenshot, diagnostics,
  hierarchy, click, type, scroll, and stop;
- diagnostics summary for console events, page errors, failed requests, and
  redacted server stdout/stderr tails;
- DOM hierarchy display with basic tag/id/class/text and box metadata;
- screenshot artifact metadata display;
- static regression tests and mobile viewport regression coverage.

Out of scope for this slice:

- live rendered iframe/proxy isolation;
- attaching screenshot artifacts directly to task/run evidence;
- reference-image comparison;
- MCP exposure.

## Acceptance Checks

- `/preview` is routable and visible in the persistent sidebar.
- Initial workspace load fetches `/api/preview-sessions` alongside existing
  workspace data.
- Operators can start a session from a configured repository command and then
  refresh/list/select it.
- Selected sessions expose controls for lifecycle actions and runtime
  interactions.
- Diagnostics, DOM hierarchy, and screenshot artifact metadata render in bounded
  panels.
- Static tests assert the route, API endpoints, forms, and handlers.
- Existing mobile viewport regression still passes.
