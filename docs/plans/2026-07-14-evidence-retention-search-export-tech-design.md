# Local Evidence Retention, Search, And Export Tech Design

## Goal

Give a pilot operator an inspectable, local-only way to answer which Nitely run
evidence is retained, find runs by operational metadata, produce a safe weekly
review package, and preview or apply age-based cleanup. The implementation is
an OSS trust primitive and does not add hosted storage, cross-repository search,
or a compliance archive.

## Current State

Nitely persists two related stores indefinitely:

- `.nitely/events.db` contains append-only run events and supplies the canonical
  run projection;
- `.nitely/runs/<run-id>` contains `run.json`, `evidence.md`, artifact metadata,
  prompts, logs, generated outputs, input snapshots, and a worktree.

The event store can append and list data but cannot delete a completed run's
event history. Operators can inspect individual runs through the CLI or Web,
but cannot search metadata across runs, build a deliberately source-free export,
or preview retention actions. Copying a run directory is not a safe export:
inputs and worktrees contain source, while evidence, prompts, logs, and generated
artifacts can contain proprietary text even after known-secret redaction.

## Policy Contract

An optional source-controlled `nitely.evidence.json` defines the local policy:

```json
{
  "apiVersion": "nitely.dev/v1alpha1",
  "kind": "EvidencePolicy",
  "spec": {
    "retention": {
      "runsDays": 90,
      "eventsDays": 365,
      "logsDays": 30,
      "artifactsDays": 60,
      "evidenceDays": 90
    }
  }
}
```

Every retention value is either a non-negative integer number of days or
`null`. Missing values and a missing file resolve to `null`, meaning indefinite
retention. Unknown kinds, versions, fields, invalid JSON, negative/fractional
values, and unsafe ordering fail closed with an actionable error.

When both run-directory and event retention are finite, `eventsDays` must be at
least `runsDays`. This ensures terminal state remains available until the run
directory can be safely selected. Component windows may exceed `runsDays`, but
the effective retention is still bounded by whole-run removal and the policy
inspection output calls that out.

`nitely evidence policy --repo <path>` prints the policy source, configured
values, effective values, and validation result. The file contains no secrets
and controls only run evidence; credentials, users, API-token audits, and the
security audit are deliberately outside this command's scope.

## Metadata Index And Search

Add a local evidence module that builds records on demand from the event store
and artifact registries. No second long-lived index is introduced, so search
cannot drift from the canonical local state. Event-backed runs use the existing
projection plus their first/latest event timestamps. A readable run directory
without events remains discoverable from `run.json`, `artifacts.json`, and file
timestamps with a conservative fallback status.

Each record exposes:

- run id, task/work-item id, repository id/name/path, and flow id/name/path;
- status, created/updated/terminal timestamps, PR URL, and blocker category;
- artifact id/name/type/media type/producer/stage/attempt/hash/size metadata;
- minimal gate outcome metadata without command output, review bodies, stdout,
  stderr, or failure prose.

`nitely evidence search --repo <path>` supports repeatable or combinable
filters for run, task, repository, flow, status, PR URL, blocker category,
date range, and artifact metadata. Text matching is case-insensitive; different
filter fields combine with AND. The normal output is a compact operator table,
while `--json` returns the versioned records for automation. Search is local and
does not upload or copy content.

## Safe Export

`nitely evidence export --repo <path> --run <id> [--run <id> ...] --output
<directory>` creates a new directory and refuses to merge into an existing
destination. Its default contents are:

```text
<output>/
├── manifest.json
├── summary.md
├── checksums.sha256
└── runs/
    └── <run-id>.json
```

The summary and per-run documents are generated from bounded structured
metadata. They contain run/task/repository/flow/status/date metadata, PR links,
blocker categories, stage and gate outcomes, artifact metadata and existing
artifact hashes, plus an explicit redaction/export classification. They exclude
absolute repository paths, input URIs, filenames and artifact paths, free-form
event payloads, evidence text, source snapshots, worktrees, prompts, logs,
generated artifact contents, gate stdout/stderr, review bodies, and blocker
messages. Known secret patterns and environment secret values are redacted again
at export time as defense in depth.

`checksums.sha256` hashes every other exported file. `manifest.json` records the
schema version, generation time, selected run ids, whether raw content is
included, and the precise excluded-content boundary. This is a safe operational
package, not a claim of tamper evidence or compliance certification.

`--include-raw` is the only way to add raw material. It adds a prominent
`RAW_CONTENT_WARNING.txt` and copies only recognized run evidence, prompt,
stdout/stderr, output files, artifact registry, and registered artifact files
under `raw/<run-id>/`. It never copies an entire run directory implicitly.
Symlinks and paths resolving outside the run directory are rejected. Raw files
remain potentially sensitive and are accurately marked as not guaranteed
redacted.

## Retention Planning And Pruning

`nitely evidence prune --repo <path>` always computes and prints a dry-run plan.
`--at <ISO timestamp>` makes the cutoff reproducible for review and testing.
Only the explicit `--apply` flag mutates state.

Selection uses a run's latest event time and terminal projection. Created,
running, awaiting-approval, and interrupted runs are never pruned. For terminal
runs older than the applicable window, the plan may select:

- the whole `.nitely/runs/<run-id>` directory;
- `stdout.log`, `stderr.log`, and other run-local log files;
- registered artifact contents and `artifacts.json`;
- `evidence.md`;
- the run's complete event history, never a partial prefix that would create a
  misleading projection.

Whole-run removal supersedes component actions. Paths are canonicalized,
symlinks are skipped, and every target must remain inside the expected run
directory. Apply rechecks terminal eligibility before deleting and performs
event deletion last. If a run became active or local state changed after
planning, that run is skipped rather than force-deleted. Secure erasure is not
promised; filesystem snapshots, backups, SSD behavior, and provider-side data
remain outside Nitely's control.

## CLI Surface

```text
nitely evidence policy --repo <path> [--json]
nitely evidence search --repo <path> [filters] [--json]
nitely evidence export --repo <path> --run <id>... --output <dir> [--include-raw]
nitely evidence prune --repo <path> [--at <ISO timestamp>] [--apply] [--json]
```

The implementation keeps parsing in `src/cli.ts` and lifecycle behavior in a
new `src/evidence/` module. `EventStore` gains only a complete-run deletion
primitive with a returned row count.

## Validation

- policy defaults, strict parsing, unsafe ordering, and effective-window tests;
- metadata search tests covering every required filter and directory fallback;
- safe-export tests that seed source, prompt, log, evidence, artifact, blocker,
  and gate-output sentinels and prove none appear by default;
- raw-export tests for explicit inclusion, warnings, hashes, path containment,
  and symlink exclusion;
- prune tests for category selection, whole-run precedence, active-run safety,
  dry-run immutability, apply behavior, and complete event-history deletion;
- CLI help, parsing, output, and error-path tests;
- existing event, projection, run, Web, build, typecheck, and full test suites.

## Rollout And Rollback

The default policy is indefinite, so upgrading does not delete existing data.
Search and export are read-only. Pruning remains inert without both a finite
policy and `--apply`. Rolling back leaves only an optional JSON policy and any
operator-created export directories; the event database schema is unchanged.
