# Issue 416: Web Preview Runtime And Playwright Provider

## Problem

Visual DevTools needs a governed way to start a repository preview, attach a
browser runtime, collect evidence, and clean up resources. The existing
credential-oriented provider layer is not a lifecycle runtime and should not be
extended with browser/session behavior.

## Scope

This slice adds a dedicated preview-session domain.

In scope:

- stable types for repository preview configuration, session state, provider
  capabilities, diagnostics, screenshots, and DOM hierarchy snapshots;
- allowlisted repository-scoped start commands from `.nitely/preview.json`;
- loopback target URL and route validation;
- readiness polling with bounded timeout, stdout/stderr tail capture, redaction,
  and process-tree termination;
- Playwright Chromium provider for navigation, reload, screenshots,
  diagnostics, DOM/layout snapshots, click, type, and scroll;
- persisted `.nitely/preview-sessions` metadata, stale-session recovery after
  restart, screenshot artifacts with SHA-256 integrity, and Web access control;
- JSON API endpoints under `/api/preview-sessions`.

Out of scope:

- Web Console preview panel UI;
- MCP exposure;
- reference-image comparison;
- Firefox, WebKit, and native runtimes.

## Acceptance Checks

- A real repository with `.nitely/preview.json` can start a preview session from
  an allowlisted command only.
- Bad commands and readiness timeouts persist failed/timed-out session records.
- Provider startup failure cleans up the started dev-server process.
- Concurrent preview sessions maintain independent runtime state.
- Restart recovery marks previously active sessions stale.
- Navigation stays on the session origin; start routes stay inside
  repository-declared `allowedRoutes`.
- Screenshot artifacts include file path, media type, size, full-page flag,
  viewport, URL, timestamp, and SHA-256 digest.
- Diagnostics include console messages, page errors, failed requests, and
  redacted server stdout/stderr tails.
- Preview endpoints are audited as `preview-session` targets and require
  `preview:view` or `preview:control`.
