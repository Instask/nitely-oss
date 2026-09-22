# Issue 418: Reference-image visual diff artifacts

## Problem

Nitely can capture implementation screenshots, but operators and later agent
tools need a reproducible image-level comparison against an approved reference.

## In scope

- Compare two run-owned PNG images: a reference and an implementation screenshot.
- Preserve existing artifact integrity checks and register linked artifacts in
  the run artifact registry.
- Emit a typed JSON result with `match`, `mismatch`, or `inconclusive`.
- Persist deterministic `diff.png`, `overlay.png`, and `side-by-side.png`
  artifacts when the comparison can run.
- Explicitly reject unsupported/corrupt inputs, dimension mismatches, pixel
  density mismatches, and color profile mismatches.

## Out of scope

- DOM-aware semantic diffs.
- Figma or external baseline APIs.
- Automatic code modification based on a diff.
- CI baseline lifecycle management.

## Acceptance checks

- Exact-match PNGs produce `match` and zero changed pixels.
- Localized differences produce `mismatch`, changed-pixel metrics, and bounding
  regions.
- Pixelmatch tolerance can suppress small antialiasing/color differences.
- Dimension mismatch, corrupt input, incompatible pixel density, and color
  profile mismatch produce `inconclusive` reports, not false matches.
- Transparent RGBA pixel differences are compared and represented in metrics.
