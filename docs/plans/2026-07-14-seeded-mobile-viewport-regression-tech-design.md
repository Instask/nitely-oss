# Seeded Mobile Viewport Regression Technical Design

Issue: [#166](https://github.com/Instask/nitely/issues/166)

## Outcome

Nitely gains a repeatable browser regression that renders populated Web Console
task and run surfaces at 360px, 390px, and 430px. The check fails on page-level
horizontal overflow and cannot pass against an empty or partially booted shell.

The implementation is test-only unless the populated fixture reveals a real
responsive defect. Existing desktop markup assertions remain in place, and the
same fixture is checked at 1280px as a desktop guard.

## Browser Boundary

The test uses `playwright-core` and launches an installed Chrome/Chromium binary.
It checks `NITELY_CHROME_PATH` first, then platform-specific standard locations.
Missing Chrome is an actionable test failure rather than a silent skip.

Using `playwright-core` keeps Nitely from downloading or packaging a browser as
part of a normal dependency install. Development and production hosts already
provide Chrome independently of the application runtime.

The browser receives the actual Web Console HTML, `support.js`, and API responses
from a real Nitely Web server bound to an ephemeral localhost port. The test does
not replace task or run endpoints with hand-written response mocks.

## Deterministic Fixture

A temporary repository contains the normal bootstrap flow and one task created
through the task store. Stable IDs and timestamps keep assertions reproducible.
The task includes a long title, source URI, issue URL, spec, and technical design.

One linked completed run is represented by the normal event database and durable
run files. Its data deliberately exercises the most overflow-prone surfaces:

- long repository, branch, worktree, artifact, and source paths;
- a long stage ID and command;
- prompt, stdout, stderr, and generated output content;
- durable context-manifest rows;
- artifact registry metadata; and
- populated run evidence and PR metadata.

The test waits for fixture-specific task and run text before measuring layout.
This proves that the client-side runtime booted and the requested populated data
rendered.

## Viewport Invariant

For each route and viewport, the primary invariant is:

```text
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

The mobile matrix is 360x800, 390x844, and 430x932. `/tasks` and the populated
run detail route are checked at every mobile width. A 1280x900 pass covers the
same routes without changing existing desktop assertions.

On failure, the test reports the route, viewport, document dimensions, and the
widest visible elements that extend beyond the viewport. Browser page errors,
console errors, failed local resource loads, and API failures also fail the test.
External font failures are ignored because the console has system-font fallbacks
and font availability is not the layout contract under test.

## Verification

- seeded mobile viewport regression at 360px, 390px, 430px, and 1280px;
- existing static responsive markup assertions;
- relevant Web server and run-detail tests;
- repository typecheck and build;
- full Vitest suite; and
- development-host browser regression plus Web smoke before production deploy.
