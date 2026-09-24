# Feature Spec: Production Web fail-closed startup

Status: draft
Source: github-issue https://github.com/Instask/nitely/issues/431

## Background

Nitely's local Web compatibility mode intentionally grants a synthetic local
administrator. That behavior is useful on a loopback development listener, but
must never become an accidental network-facing production configuration.

## User Stories

- **US-001:** As an operator, I get a startup error before Nitely exposes an
  unauthenticated or plaintext network listener.
- **US-002:** As an operator, I can inspect the exact authentication, bind, and
  transport controls active for a running Web server.
- **US-003:** As an administrator, I can explicitly bootstrap the first account
  without Nitely generating or sharing a default credential.

## Functional Requirements

- **FR-001:** Local authentication mode is allowed only on a loopback listener
  outside production mode.
- **FR-002:** A non-loopback listener requires authenticated mode, an explicit
  trusted reverse-proxy boundary, and secure session cookies.
- **FR-003:** `NODE_ENV=production` requires authenticated mode and a configured
  administrator before the socket is opened.
- **FR-004:** Initial administrator creation continues to require explicit email
  and password values, happens only when the user store is empty, and writes a
  metadata-only security audit event. The user, default organization, and audit
  commit are idempotently recoverable after interruption and become usable only
  after the complete bootstrap transaction is durable.
- **FR-005:** Invalid auth, secure-cookie, and trusted-proxy configuration is
  rejected instead of silently falling back.
- **FR-006:** A public readiness response and CLI startup output expose the
  active auth mode, admin state, bind scope, transport boundary, secure-cookie
  state, and production state without exposing credentials.
- **FR-007:** The production systemd installer binds to loopback and passes
  `--auth required` by default. A non-loopback unit requires an explicit
  trusted-proxy option and enables secure cookies.
- **FR-008:** An installer upgrade preserves a supported existing secure unit.
  It refuses an insecure or unclassifiable effective unit until the operator
  explicitly requests a backed-up replacement.

## Acceptance Scenarios

1. A local-mode server on `127.0.0.1` starts for development.
2. A local-mode server on `0.0.0.0` fails before listening.
3. An authenticated non-loopback server without a trusted proxy, or without
   secure cookies, fails before listening.
4. A production server without an administrator fails before listening.
5. Explicit first-admin credentials create one administrator and one redacted
   `auth.bootstrap` audit event.
6. The readiness response reports all active boundary controls.
7. The rendered production unit is authenticated and loopback-bound by default;
   non-loopback rendering is rejected unless trusted-proxy mode is explicit.
8. Interrupting bootstrap after its intent, user, organization, or audit commit
   resumes to one administrator, one owner membership, and one audit event.
9. Re-running the installer preserves a secure unit, rejects an insecure unit,
   and backs it up only after explicit replacement authorization.

## Failure Behavior

- Startup errors name the missing control and the configuration needed to fix
  it. Nitely never widens the listener or downgrades auth automatically.
- Invalid boolean-like values are configuration errors.
- Bootstrap/audit failure occurs before `listen`, so an incompletely initialized
  process is not network reachable. A durable pending intent is replayed on the
  next start, and a malformed intent or user record fails closed.
- Existing systemd units and drop-ins are never silently overwritten during an
  upgrade.

## Out of Scope

- Built-in TLS termination. This slice supports loopback and an explicitly
  declared trusted reverse-proxy TLS boundary.
- OIDC, SCIM, or proxy-managed user identity.
- Firewall provisioning or reverse-proxy configuration.
- Automatically migrating arbitrary hand-edited systemd units.
