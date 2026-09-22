# Nitely JSON Flow and Connector Design

Date: 2026-06-19
Status: Approved

## Objective

Use JSON as Nitely's only flow definition format and allow run inputs such as
PRDs, technical designs, and specifications to come from external systems.

The MVP implements the connector boundary and a local-file connector. Google
Drive support is added later without changing the scheduler or agent runtime.

## Decisions

### JSON-only flows

Flow files use `.json` and are parsed with `JSON.parse`. YAML is removed from
the runtime and dependencies. The schema remains `nitely.dev/v1alpha1`.

### Resource references

Run inputs are named resources:

```json
{
  "spec": {
    "connector": "local-file",
    "uri": "./specs/add-feature.md"
  },
  "tech-design": {
    "connector": "google-drive",
    "uri": "https://docs.google.com/document/d/..."
  }
}
```

The CLI may later provide shorthand flags, but the application boundary receives
the normalized `{ connector, uri, options? }` form.

### Connector boundary

```ts
interface Connector {
  readonly type: string;
  fetch(input: ConnectorFetchInput): Promise<FetchedResource>;
}
```

`FetchedResource` contains metadata, media type, optional source revision, and
content as bytes. Connectors fetch only; they do not know about flows, stages,
agents, Git worktrees, or scheduling.

### Snapshot before execution

At run startup, Nitely resolves every external resource once and writes an
immutable snapshot under:

```text
.nitely/runs/<run-id>/inputs/<artifact-id>/
├── content
└── metadata.json
```

Stages consume these local snapshots as artifacts. They never fetch Google Drive
or another remote system directly. This gives reproducibility, bounded context,
and a stable audit record even if the source document changes later.

### Connector registry

A small registry maps connector type to implementation. Unknown connector types,
duplicate registrations, unreadable resources, and failed fetches are explicit
errors. Credentials remain connector-specific and are not persisted in artifact
metadata.

## Initial scope

Included:

- JSON flow loader.
- Connector types and registry.
- Local-file connector.
- Immutable input snapshot contract.

Deferred:

- Google OAuth and Google Drive API integration.
- Google Docs export-format selection.
- Connector configuration UI.
- Refreshing resources during a run.
- Connector marketplace or plugin loading.

