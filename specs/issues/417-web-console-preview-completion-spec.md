# Issue 417 Completion: Isolated Live Preview And Evidence Attach

## Problem

The first Web Console preview slice can start and inspect sessions, but it does
not yet satisfy the full #417 acceptance criteria for a live rendered preview,
restart control, or screenshot evidence attachment.

## Scope

In scope:

- bind preview sessions to optional `workItemId` / `runId` metadata after
  checking the caller can see that target;
- render ready sessions in a live iframe through a server-side same-origin proxy;
- force an iframe/proxy isolation model that does not make preview app content
  same-origin trusted Console UI;
- add restart as a first-class session action;
- attach captured screenshots to run evidence by copying the PNG into the run
  and registering a `preview-screenshot` artifact;
- allow work-item attachment through the work item's latest run;
- cover proxy CSP, attachment registry output, restart, and Console controls in
  tests.

Out of scope:

- general reverse-proxy support for arbitrary non-loopback origins;
- reference-image comparison and visual diff (#418);
- MCP/API agent visual tools (#419);
- production iOS/Android native provider support (#420).

## Acceptance Checks

- `/preview` shows a live frame for ready sessions and an empty state for
  non-ready sessions.
- The iframe sandbox does not include `allow-same-origin`.
- Preview proxy requests require `preview:view`, stay on the session origin,
  do not forward browser cookies to the preview app, and return a CSP `sandbox`
  header.
- Session restart stops the active runtime and starts a replacement session.
- Captured screenshots can be attached to a run's artifact registry with
  integrity metadata.
- Static Console tests cover the route, live frame, restart, and attach controls.
- Web API tests cover proxy isolation, screenshot attachment, and restart.
