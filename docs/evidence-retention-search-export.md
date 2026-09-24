# Local Evidence Retention, Search, And Export

Nitely keeps run evidence local. Operators can inspect an effective retention
policy, search structured run metadata, export a source-free closeout package,
and preview or apply retention cleanup without a hosted service.

These commands cover only run evidence in `.nitely/events.db` and
`.nitely/runs`. They do not prune provider credentials, users, API tokens,
API-token audit, or the security audit.

## Configure Retention

Without a policy file, every category is retained indefinitely. To configure
local windows, add `nitely.evidence.json` at the repository root:

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

Each value is a non-negative integer number of days or `null`. Missing values
mean indefinite retention. The categories are:

- `runsDays`: the complete `.nitely/runs/<run-id>` directory;
- `eventsDays`: the run's complete history in `.nitely/events.db`;
- `logsDays`: run-local `*.log` files, excluding inputs and worktrees;
- `artifactsDays`: `artifacts.json`, registered artifact files, and recovery
  patch/metadata checkpoints;
- `evidenceDays`: the generated `evidence.md` summary.

Some sanitized command output is also embedded in run events. `logsDays`
controls the run-local log files only; `eventsDays` controls how long event
payload copies remain. Prompts, input snapshots, and worktrees remain until the
whole run directory is removed.

When `runsDays` and `eventsDays` are both finite, `eventsDays` must be at least
`runsDays`. Nitely needs the terminal event projection to decide whether the
run directory is safe to select. A component window longer than `runsDays` is
effectively capped by whole-run removal.

Inspect and validate the configured and effective policy:

```bash
node dist/index.js evidence policy --repo .
node dist/index.js evidence policy --repo . --json
```

Invalid JSON, unknown fields, unsupported versions, negative/fractional days,
and unsafe event/run ordering fail closed. Adding a policy never schedules or
performs deletion by itself.

## Search Run Metadata

Search reads the local event projection and artifact registries on demand. It
does not create a hosted index or upload content.

```bash
node dist/index.js evidence search --repo . --status blocked
node dist/index.js evidence search --repo . \
  --repository payments \
  --flow release \
  --from 2026-07-01T00:00:00Z \
  --to 2026-07-07T23:59:59Z
node dist/index.js evidence search --repo . --artifact closeout --json
```

Available filters are `--run`, `--task`, `--repository`, `--flow`, `--status`,
`--pr`, `--blocker`, `--from`, `--to`, and `--artifact`. Text filters are
case-insensitive and different fields combine with AND. Date filters use the
run's latest recorded activity time. Search also discovers readable `run.json`
directories whose events are no longer present, using a conservative fallback
projection.

Searchable artifact metadata includes id, name, type, producer, media type,
stage, attempt, filename/path/source URI, hash, and size. Search is local, so
`--json` can contain local paths; do not treat search JSON as a safe sharing
format. Use the export command for that boundary.

## Export A Safe Closeout Package

Select one or more exact run ids and a new output directory:

```bash
node dist/index.js evidence export --repo . \
  --run run-01 \
  --run run-02 \
  --output ./nitely-closeout-2026-w28
```

The command refuses to merge into an existing directory. The default package
contains:

```text
nitely-closeout-2026-w28/
├── manifest.json
├── summary.md
├── checksums.sha256
└── runs/
    ├── run-01.json
    └── run-02.json
```

The metadata-only documents contain run/task/repository/flow/status/date
metadata, PR links, blocker categories, stage and gate outcomes, artifact
metadata, and existing artifact hashes. `checksums.sha256` hashes every other
file in the package.

The default package excludes absolute repository/flow paths, inputs and source
URIs, source snapshots, worktrees, evidence text, prompts, logs, artifact paths
and filenames, artifact contents, gate commands/output/review bodies, and
blocker messages. Known secret forms and environment secret values are redacted
again while generating metadata. This is a practical no-source sharing
boundary, not a tamper-evidence or compliance certification.

Artifact ids/names, repository names, task ids, flow names, PR URLs, and other
selected metadata can themselves be confidential. Review the generated package
before sharing it outside the intended audience.

### Explicit Raw Export

Raw material is opt-in:

```bash
node dist/index.js evidence export --repo . \
  --run run-01 \
  --output ./nitely-closeout-raw \
  --include-raw
```

The package is classified `sensitive-raw-opt-in` and includes
`RAW_CONTENT_WARNING.txt`. Nitely copies only recognized `evidence.md`,
`prompt.md`, `stdout.log`, `stderr.log`, `output.md`, `artifacts.json`,
`recovery.json`, `recovery.patch`, and registered artifact files under
`raw/<run-id>/`. It does not copy the complete run directory, input snapshots,
or worktree. Symlinks and registered artifact paths outside the run directory
are rejected.

Raw files are not guaranteed to be redacted and may contain source, prompts,
proprietary output, or secrets. Use them only when the recipient and storage
location are approved for that content.

## Preview And Apply Retention

The prune command is always a dry-run unless `--apply` is present:

```bash
node dist/index.js evidence prune --repo .
node dist/index.js evidence prune --repo . --json
```

The plan lists the run, category, target count, and cutoff. Only terminal
`completed`, `failed`, `blocked`, or `cancelled` runs are eligible. Created,
running, awaiting-approval, and interrupted runs are preserved regardless of
age. Whole-run selection supersedes component file actions; event history is a
separate action and is deleted only as a complete run history.

After reviewing the plan, apply the same policy:

```bash
node dist/index.js evidence prune --repo . --apply
```

`--at <ISO timestamp>` pins the evaluation time for an auditable/reproducible
plan. Apply recomputes eligibility and skips actions whose run/event state
changed after planning. Event deletion is performed last.

Pruning is normal filesystem/SQLite deletion, not secure erasure. Backups,
snapshots, SSD behavior, copied exports, and provider-side retention remain
outside Nitely's control. Back up evidence required for recovery or audit before
applying a finite policy.
