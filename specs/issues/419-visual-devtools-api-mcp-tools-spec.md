# Issue 419: Scoped Visual DevTools API and MCP tools

## Problem

The Web Console can drive preview sessions, but coding agents need the same
bounded loop through the JSON API and local MCP adapter without inheriting broad
task/run authority.

## First slice

- Add explicit API-token capabilities:
  - `preview:read`
  - `preview:control`
  - `preview:compare`
- Map typed preview-session JSON endpoints to those capabilities.
- Keep the preview proxy out of API-token access in this slice because it is an
  HTML proxy surface, not a bounded tool result.
- Add MCP tools for preview lifecycle, navigation, screenshots, diagnostics,
  hierarchy, interactions, and visual comparison.
- Add `POST /api/preview-sessions/:id/compare-reference` to create run evidence
  using the #418 visual comparison artifact API.

## Security and output rules

- Task/run capabilities do not authorize preview control.
- Browser-control and comparison capabilities require high-impact confirmation
  when creating API tokens.
- MCP tools return structured API responses. Screenshot and comparison tools
  return artifact metadata and typed JSON, not raw image bytes.
- API token request audit records preview session targets when the session id is
  safe to persist.
- Existing Web session ownership and repository scoping remain authoritative for
  the underlying preview session.

## Acceptance checks

- Route-to-capability tests cover preview read/control/compare mappings and
  proxy denial.
- MCP tests cover every preview tool route and request body.
- Web preview tests cover capture → attach → compare on Linux run-owned
  artifact storage.
- Existing task/run MCP flows remain unchanged.
