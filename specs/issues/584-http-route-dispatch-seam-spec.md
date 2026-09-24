# Issue #584 — HTTP route dispatch seam

## Problem

The Web server mixes method/path matching, static-file fallback, request
mechanics, and domain handlers in one large dispatcher.

## Scope of this slice

Introduce a dependency-free first-match HTTP route seam and move the complete
HTML/static route family through it. A route may decline after matching, which
preserves the existing 404 fallback when a static asset is absent. API domain
handlers, authentication, audit, and error translation remain unchanged in this
slice.

## Acceptance checks

- GET-only routes do not handle other methods.
- First matching route wins; a declining route permits fallback routes.
- Existing console, device, support, task, run, and flow HTML paths retain
  their responses and security headers.
- Dispatcher behavior is independently unit-tested without starting a server.
- No routing dependency is added.
