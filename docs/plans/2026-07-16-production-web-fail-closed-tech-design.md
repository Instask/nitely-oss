# Production Web fail-closed technical design

## Scope

This slice adds a startup policy at the only socket-opening boundary,
`startWebServer`, then makes the production systemd renderer select that secure
path by default. It does not implement a TLS server; non-loopback service is
valid only when the operator explicitly declares a trusted reverse proxy and
secure cookies.

## Startup policy

Before administrator bootstrap or `server.listen`, normalize and validate:

1. auth mode (`local` or `required` only);
2. bind scope (`localhost`, IPv4 loopback, or IPv6 loopback versus network);
3. `NITELY_WEB_TRUSTED_PROXY` and `NITELY_WEB_SECURE_COOKIE` as strict booleans;
4. production mode from `NODE_ENV=production`.

Local auth is limited to non-production loopback. Network binds require
required auth, trusted-proxy declaration, and secure cookies. Production also
requires an existing or explicitly bootstrapped administrator.

## Bootstrap and audit

The bootstrap contract accepts no generated credential: both
`NITELY_ADMIN_EMAIL` and `NITELY_ADMIN_PASSWORD` must be present and the user
store must be empty. Before changing user state it writes an owner-only recovery
intent containing the salted verifier, fixed user/organization/audit IDs, and
timestamp. A process lock serializes concurrent starts. Replay durably writes
and fsyncs the user and owner membership, then appends and fsyncs the fixed-ID
metadata-only `auth.bootstrap` event. Only then is the intent atomically replaced
with a completed marker containing identifiers but no verifier. Every step is
idempotent, so process interruption resumes without plaintext credentials or
duplicate users, memberships, or audit events. Invalid journal, user, or audit
state fails before the listener opens.

## Readiness

`WebSecurityReadiness` is returned with the server and served from
`GET /api/readiness`. It reports structured control state, not request headers
or secrets. The nested response is frozen before listener creation so in-process
consumers cannot mutate validated control state. IPv6 listener URLs are bracketed,
and only fully well-formed loopback hosts are classified as local. The endpoint
uses 503 only for the supported loopback setup state
where required auth is selected but no administrator exists; production and
network-facing startup reject that state entirely.

## systemd

The renderer changes its default bind from `0.0.0.0` to `127.0.0.1`, always
sets required auth, and never embeds administrator credentials. `--trusted-proxy`
is required for a non-loopback host and renders both the proxy declaration and
secure-cookie setting. During an upgrade, a supported existing unit is preserved
only if required auth and either a loopback bind or both proxy/cookie controls
classify as secure. Symlinks, environment files, and drop-ins are unclassifiable
and fail closed. Insecure or unclassifiable units are left untouched unless the
operator explicitly passes `--replace-existing`; replacement first backs up the
unit and user drop-ins, then atomically installs the generated secure unit.
The installer asks systemd for `FragmentPath` and `DropInPaths`; it refuses even
an authorized replacement when an effective fragment or drop-in sits outside
the managed user unit and therefore cannot be neutralized safely.

## Verification

- Unit/integration tests cover loopback compatibility, every non-loopback
  rejection, production missing-admin rejection, audited bootstrap, readiness,
  invalid configuration, four bootstrap interruption boundaries, concurrent
  bootstrap, and rendered/preserved/rejected/replaced systemd controls.
- Run TypeScript check/build and the relevant Web/script suites locally, then
  run the full suite on the Linux development checkout before handoff.
