# Risk-Based Review Policy

Nitely already decides *whether* a work item may run. This decides how much
human attention the change it produced has earned — from what the agent
actually changed, not only from what the work item declared.

A nominally low-risk task can produce a diff that touches authentication,
payments, a database migration, or a dependency manifest. Declared intent
alone would let that ship with the review a routine change gets. So every
publication decision combines two things:

1. **Declared intent** — the work item type, its governance class, and
   repository policy.
2. **Actual effect** — the diff this run produced: changed paths, deletions,
   migrations, dependency manifests, size, and CODEOWNERS ownership.

The result is an *effective risk class*, and that class decides the review the
change request needs.

## Risk Classes

| Class | Meaning | Default requirement |
| --- | --- | --- |
| `mechanical` | Reversible, verifiable by machine | No human approval, auto-merge eligible |
| `normal` | Ordinary scoped change | One human approval |
| `high` | Behavioral change with blast radius | Two approvals, code owner, draft only |
| `protected` | Auth, payments, crypto, secrets, destructive schema work | Two approvals, code owner, no unattended publication |

Defaults are deliberately conservative and repository-configurable. The
effective class is the **maximum** of the declared baseline and every diff
signal: a signal can raise a change's class, never lower it. Only repository
policy sets the baseline, and only explicitly.

## Deterministic Signals

The first version uses only deterministic signals, so escalation never depends
on a model's opinion:

- **protected path** — a changed path matching an `auth`, `payment`, `crypto`,
  or `secrets` pattern. Raises to `protected`.
- **database migration** — a changed migration directory or `.sql` file.
  Raises to `high`.
- **dependency manifest** — a changed manifest or lockfile
  (`package.json`, `pnpm-lock.yaml`, `go.mod`, `Cargo.toml`, …). Raises to
  `high`.
- **destructive change** — the diff deletes files. Raises to `high`.
- **diff size** — more than 40 changed files or 800 changed lines. Raises to
  `high`.
- **code owner** — a changed path has a CODEOWNERS entry. Names who must look;
  does not by itself make the change riskier.

Renames count on both their old and new path, so moving a file out of
`src/auth/` is still an auth change.

Semantic classification can be added later as an optional judge input. It is
not required, and it must never be able to talk a deterministic signal down.

## Evidence

The classification is recorded as a `run.risk.classified` run event, so it is
durable, survives resume, and is projected into the Web Console alongside the
run. The `## Risk Classification` section of run evidence — which is the
change request body — states the declared class, the effective class, every
signal with the exact paths that raised it, and the resulting requirement.

The explanation is written for the person whose attention is being asked for:

> Escalated from normal to protected risk because the diff changes
> auth-sensitive paths (src/auth/session.ts), and the diff changes 1 database
> migration (db/migrate/001.sql).

Each classification carries a digest of the diff it was computed from, so a
stale classification is detectable rather than silently reused. Nitely
recomputes it at every publication decision: a rework that changes the diff is
re-classified before the change request is updated, never inheriting the
verdict the previous diff earned.

## What Is Enforced In The Run

A published change request is a **draft pull request, not a merge**. The
approval counts are requirements on that pull request, enforced by GitHub
branch protection and CODEOWNERS, which Nitely complements rather than
replaces.

The one thing the run itself enforces is `requireRunApproval`: when the
effective class demands it, a protected stage refuses to publish or update
unless the run carries an approved approval gate. By default only `protected`
demands it — publishing an auth or payments change with no human in the loop
is the case worth stopping before the side effect, and the failure names the
signals that escalated it.

The existing protected-action fail-closed behavior is unchanged; this runs
alongside it.

## Repository Configuration

`.nitely/review-policy.json` is optional. Without it, the built-in defaults
above apply.

```json
{
  "baselineByWorkItemType": {
    "docs.update": "mechanical"
  },
  "signals": {
    "protectedPaths": {
      "auth": ["src/auth/**", "src/session/**"],
      "tenancy": ["internal/tenancy/**"]
    },
    "migrations": ["db/migrate/**"],
    "dependencyManifests": ["package.json", "pnpm-lock.yaml"],
    "diffSize": { "files": 60, "lines": 1200 }
  },
  "classes": {
    "high": { "requiredApprovals": 2, "requireCodeOwner": true },
    "protected": { "requireRunApproval": true, "allowUnattendedMerge": false }
  }
}
```

`signals` replaces the built-in patterns for the keys it names. `classes`
merges onto the defaults field by field, so a policy that changes one number
keeps the rest. A malformed policy is rejected rather than quietly ignored —
a review policy that silently fails open is worse than none.

Keep this separate from project-management priority. A `P0` bug fix that
changes one line of a log message is still a `normal` change; a typo fix in
`src/auth/` is not.

## Related

- `docs/work-item-model.md` — declared governance and protected actions.
- `docs/multi-perspective-review.md` — how much machine review the change gets
  before it reaches a human.
- `docs/security-and-trust.md` — the wider fail-closed posture.
