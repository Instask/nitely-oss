# Jira Ticket Ingestion Technical Design

Issue: [#231](https://github.com/Instask/nitely/issues/231)

## Outcome

Nitely can turn a Jira ticket into the same approval-first planning task used by
GitHub issue intake. Jira is an upstream planning source, not a generic file
connector and not a new run/work-item model.

Operators can paste a Jira browse URL, or a ticket key when a Jira base URL is
configured. Nitely snapshots the ticket, reuses the existing task on replay,
records source drift without overwriting the approved baseline, and can post a
bounded current-status comment back to Jira when that option is enabled.

## Shared Ticket Model

A provider-neutral normalized ticket model sits between provider APIs and the
existing task source record. Both the current GitHub adapter and the new Jira
adapter map into it. The normalized fields are:

- provider source type and stable external id;
- canonical URL, title, body, state, state category, and update time;
- author/reporter, assignees, labels, and milestone;
- comments;
- attachment metadata only (id, filename, MIME type, size, and provider URL);
- linked-ticket metadata (relationship, key, title, status, and provider URL).

The durable task snapshot gains the fields Jira needs but remains backward
compatible with existing GitHub task JSON. Drift comparison covers every
normalized field except `fetchedAt`, so fetching the same revision does not
create false drift.

The legacy `issueUrl` task field continues to hold the canonical upstream URL
for compatibility. Provider identity and deduplication use the task source type,
external id, and normalized source URI.

## Jira Boundary

The Jira adapter uses Jira REST API v3. It supports canonical browse URLs such
as `https://example.atlassian.net/browse/ENG-123`. A bare `ENG-123` key is
accepted only when `NITELY_JIRA_BASE_URL` is configured.

To avoid turning ticket ingestion into an arbitrary server-side request, an
unconfigured URL is accepted only for HTTPS Atlassian Cloud hosts. Self-hosted
Jira URLs must match the configured `NITELY_JIRA_BASE_URL`. URL credentials and
non-HTTPS remote sites are rejected; localhost HTTP remains available for
explicit development fixtures. Query strings and fragments copied from Jira are
stripped before the canonical ticket URL is persisted or fetched.

Ticket descriptions and comments may use Atlassian Document Format (ADF). The
adapter converts supported ADF nodes into deterministic plain text for the
local snapshot and draft generator. Unknown container nodes are traversed
instead of dropping their text. Comments are fetched through the paginated
comment endpoint rather than relying on the issue response's first page.

## Credentials And Failure Semantics

`jira` becomes a Web Console provider. The provider stores only the token in
the customer-controlled provider store. Environment configuration is:

- `NITELY_JIRA_BASE_URL`: allowed Jira site and the default for bare keys;
- `NITELY_JIRA_TOKEN` or `JIRA_API_TOKEN`: token fallback;
- `NITELY_JIRA_EMAIL`: when present, use Jira Cloud Basic authentication with
  `email:token`; otherwise use the token as a Bearer credential for OAuth/PAT
  deployments.

Anonymous fetch remains possible for publicly readable tickets. Jira 401/403/
404 responses distinguish missing-credential setup guidance from configured
credential access failures. HTTP 429 reports a rate-limit error and includes a
bounded retry-after hint when supplied. Tokens and authorization headers are
never persisted in task source, status-sync metadata, or error text.

## Planning Flow And Provenance

`POST /api/draft-specs` accepts `sourceType: "jira-ticket"`. After normalization,
GitHub and Jira follow one path:

1. fetch and normalize the source;
2. find an existing task by provider identity/canonical URI;
3. calculate drift against the immutable baseline snapshot;
4. reuse the existing task or generate a draft spec and placeholder design;
5. persist the normalized snapshot and unchanged drift baseline.

The generated spec includes the Jira source type and URL plus the ticket body
excerpt. Planning artifact revisions explicitly list the durable task
`execution/source.json` snapshot as an input. Draft technical designs include a
visible source-snapshot line and record both the approved spec revision and the
source snapshot as inputs. Refreshing changed Jira planning uses the same
endpoint and resets spec/design approval just like GitHub source refresh.

## Optional Jira Status Sync

Jira status sync is off by default. Jira intake accepts an explicit enable flag
and a public Nitely Web base URL. The non-secret configuration is stored on the
task source record. The Web form sends its current origin only when the operator
enables sync.

An enabled intake posts the initial planning status. Task detail also exposes a
manual `Sync to Jira` action so the operator can publish the current planning,
run, and PR state after later transitions. The comment contains bounded links
to the task, spec/design views, latest run, and change request when available.

The status projection is hashed. Repeating sync without a task/run/PR change
returns an unchanged result and does not create another comment. The task stores
only the last fingerprint, attempt/success time, returned comment URL, and a
sanitized last error. Disabling sync makes the endpoint fail closed before any
provider write.

Status comments use ADF with explicit link marks. A failed initial comment does
not discard an already-created local planning task; the API returns the clear
sync failure and the operator can fix credentials and retry from task detail.

## Interfaces

- Web Console Plan Work source option: Jira ticket.
- MCP `draft_spec` source option: `jira-ticket`.
- API intake: existing `POST /api/draft-specs` with optional `syncStatus` and
  `publicBaseUrl` for Jira.
- API status action: `POST /api/tasks/:id/sync-source-status`.
- Existing `POST /api/tasks/:id/refresh-source-planning` supports both GitHub
  and Jira normalized ticket sources.

The new status mutation uses the existing task-write authorization, API-token
capability, organization ownership checks, and security audit mapping.

## Verification

- Jira URL/key parsing and SSRF boundary tests;
- ADF, comments pagination, attachment, linked-ticket, and credential tests;
- missing/invalid credential and rate-limit errors;
- Web/API ingestion, replay deduplication, organization isolation, drift, and
  planning refresh;
- sync disabled, successful ADF comment, unchanged deduplication, and failure
  retry behavior;
- provider store/status tests and MCP schema coverage;
- planning artifact source-input provenance;
- existing GitHub intake regression coverage;
- repository typecheck, build, full test suite, development preflight, and
  production Web/API/CLI smoke.
