# Console Simplification: Fewer Surfaces, Repo Without Path, Global Skills

Date: 2026-09-19
Status: approved design
Related: `docs/fresh-remote-run-baseline.md`, `docs/factory-queue.md`,
`docs/positioning.md` ("What Nitely Is Not")

## Problem

A first hands-on pass through the Web Console produced six observations:

1. The task detail page is cluttered. Its header renders up to twelve action
   buttons; the right rail lays out every lifecycle stage at once (spec
   approval, design approval, preflight, readiness, source drift, Jira sync,
   open questions), eleven metadata rows, input sources, artifacts, and a
   rework form. A task is in exactly one stage at a time, but the page shows
   all of them.
2. The Inbox layout breaks at desktop width. Each row is a fixed three-column
   grid (`minmax(0,1fr) 190px minmax(320px,auto)`) whose third column holds an
   assignment form, a reason textarea, and an action button group.
3. The Scheduler page is weak. It stacks a Factory Queue panel, three metric
   tiles, an execution queue, a hand-drawn DAG canvas, and confirmed/suggested
   edge lists. The DAG in particular is not worth its screen.
4. Repositories expose a server path. The list has a Path column and the
   add-repository form has an "Existing server path" field. Runs already
   fetch a fresh remote baseline into a disposable worktree
   (`docs/fresh-remote-run-baseline.md`); the path is a server-side clone that
   doubles as a state directory, not something an operator should think about.
5. Skills are bound to a repository. `loadSkill` reads
   `<repo>/.nitely/skills/<id>`, the Skills page has a Repository column, and
   the import form requires choosing a repository first. `.nitely/skills` is
   not committed to any repository — it is a server-local directory that
   happens to be partitioned by repo.
6. Providers are undifferentiated. Eight identical cards mix an SCM provider
   (GitHub), five execution runtimes (Codex, Claude, GLM, Grok, Pi), and two
   input sources (Google Drive, Jira). Their status badges conflate "env var
   present", "CLI command works", and "credential stored".

Underneath 4 and 5 is one root cause: the console's `--repo <path>` is both the
global state root (`.nitely/users`, sessions, audit, `repositories.json`) and a
hard-coded repository with id `default`. Home and repository are the same
directory, so every per-repo concept inherits a path.

The open roadmap (#640–#658: enterprise SSO/SCIM, hosted control plane,
executable skills, OAuth providers) is all addition. This design is
subtraction, and it changes the shape those issues must fit into.

## Decision

- The console home directory is a state directory, not a repository. The
  `default` repository is retired. Every repository is registered by GitHub
  URL and cloned into a managed directory under home; the path never leaves
  the server.
- Skills are a single global asset set at `<home>/.nitely/skills/<id>/`. There
  is no per-repository skill lookup and no override layer.
- Providers carry a `role` and an `auth` descriptor so the UI can group them
  and state their status in three fixed lines.
- The sidebar shrinks from ten entries to six plus Settings. Scheduler,
  Stability, and Preview lose their top-level entries; Scheduler's execution
  queue folds into Tasks, Stability folds into Dashboard, Preview is reached
  from a repository row (preview sessions are keyed by repository, not by run).
- The task detail page shows one primary action, an overflow menu, a
  five-step lifecycle stepper that expands only the current or blocked step,
  five metadata rows, and a collapsed Evidence block.
- The Inbox row becomes a two-band layout with no fixed column widths and a
  reason field that appears only after an action that requires one.

## Design

### 1. Information architecture

Sidebar after the change:

```
Dashboard
Tasks
Inbox
Repos
Flows
Skills
────────
Settings   (Providers live here; future org/user admin lands here too)
```

| Entry | Change |
|---|---|
| Dashboard | Gains an "Agents needing attention" card whose count is the former `agentStabilityAttentionCount`. Clicking it opens the existing Stability list at its existing route. |
| Tasks | Gains a status filter chip row (`All / Running / Runnable / Blocked / Awaiting approval`) fed by the existing scheduler summary. The inline "Plan work" form moves into the New task drawer. The repository strip (which showed paths) is removed. The sidebar count becomes the runnable count. |
| Inbox | Layout rewritten (section 5). |
| Repos | Columns: Repository / Branch / Source. No Path. Each row gets an "Open preview" action that opens the existing Preview view scoped to that repository. The add form has GitHub URL, optional Name, optional Default branch. |
| Flows | Unchanged. |
| Skills | Columns: Skill / Description / Resources. No Repository column; import form has no repository select. |
| Settings → Providers | Three grouped sections (section 4). |

Removed from the sidebar: Scheduler, Stability, Preview. Their routes still
resolve so bookmarks work: `/agent-stability` and `/preview` render as before;
`/scheduler` redirects to Tasks with `?status=runnable`. The Scheduler view
template, the DAG canvas, edge lists, DAG layout code, and the Factory Queue
panel are deleted from the console.

### 2. Home and repository model

**Home.** `nitely web --repo <path>` is renamed `nitely web --home <dir>`;
`--repo` remains as an alias. Home owns `<home>/.nitely/` only: `users/`,
sessions, security audit, `repositories.json`, `skills/`, and the managed
clones under `repositories/<id>/`. The `--repository <id>=<path>` option is
removed; registration happens through the UI or API with a URL.

**Repository.** `WebRepository.path` stays as a server-internal field. It is
stripped from every API response and never rendered. `AddWebRepositoryInput`
loses `path`; a request that includes `path` is rejected with 400. `githubUrl`
becomes required. The clone lands at `checkoutPath(home, id)` as today.

**Retiring `default`.** `resolveWebRepositories` no longer synthesizes a
`default` entry from home. On startup the server runs an idempotent migration:

1. If `<home>` is a git repository with an `origin` remote, parse the remote as
   a GitHub URL.
2. If `repositories.json` has no entry with the same source key, append
   `{ id: sanitizeRepoId(owner-repo), name: owner/repo, sourceUrl, path: home,
   defaultBranch }`.
3. Otherwise do nothing.

Runs recorded under `<home>/.nitely/runs` continue to belong to that entry
because its `path` is home. A later attempt to register the same URL fails
with the existing `duplicate repository source` error. A home with no `origin`
registers nothing; the Repos page is empty and prompts for a URL.

The synthetic golden-path demo repository is untouched; it does not go through
UI registration.

**Not changed:** the run model, worktree creation, fresh-remote baselining,
per-repository `<repo.path>/.nitely/runs`, `events.db`, and
`connections.json`. Those stay anchored on the internal path.

### 3. Global skills

`loadSkill`, `importSkill`, `validateSkillDirectory` callers, and the Skills
list API drop their `repoPath` parameter and resolve
`<home>/.nitely/skills/<id>/SKILL.md`. The unknown-skill error message names
that path. `src/eval/replay.ts` reads the same location.

Startup migration, idempotent: for each registered repository, for each
`<repo.path>/.nitely/skills/<id>/`:

- if `<home>/.nitely/skills/<id>/` does not exist, copy the directory there;
- if it exists with the same `contentHash`, skip;
- if it exists with a different `contentHash`, do not copy; log one error
  line per conflict naming both paths.

Source directories are left in place. Nothing reads them after migration.

### 4. Provider descriptors

`ProviderDescriptor` gains:

```ts
role: "runtime" | "scm" | "input";
auth: "api-key" | "cli-login" | "token";
```

Assignments: GitHub `scm`/`token`; Codex `runtime`/`cli-login`; Anthropic
`runtime`/`api-key` (the OAuth-token alternate stays an implementation detail
of the same card); GLM `runtime`/`api-key`; Grok `runtime`/`cli-login`; Pi
`runtime`/`cli-login`; Google Drive `input`/`token`; Jira `input`/`token`.

Status computation is unchanged. The Settings page renders three sections with
one-line descriptions:

- **Runtimes** — the coding agents that execute flow stages.
- **Source control** — pushes branches and opens pull requests.
- **Inputs** — read tickets and documents during planning.

Each card shows: name + status dot; authentication method; current detection
result; what is missing (omitted when nothing is missing). The credential
input and Save/Clear buttons stay where they are.

### 5. Task detail and Inbox

**Primary action.** A pure function `primaryAction(task)` returns the first
truthy entry of `approveSpec → draftTechDesign → approveTechDesign → startRun
→ viewLatestRun` by consulting the existing `can*` flags. When none is true
the header shows the current status badge in the button's place.

**Overflow menu.** `Run preflight`, `Start with source override`, `Start with
readiness override`, `Refresh planning`, `Sync to Jira`, each gated by its
existing `can*` flag. An empty menu is not rendered.

**Stepper.** Five steps: `Spec / Design / Preflight / Run / PR`. Each has a
state `done | current | blocked | pending`. Only `current` and `blocked` steps
expand, showing that step's issue text, remediation, source drift, and open
questions. Stepper state is derived by a pure function from the same task
view model the page already builds.

**Metadata.** Flow, Repository, Issue, Created, Updated. Type, Priority,
Dependencies, Spec file, Design file are removed.

**Evidence.** Input sources and Artifacts move into one collapsed block,
closed by default.

**Request changes.** Unchanged.

**Inbox row.** Two bands. Top: badge, type label, title, body. Bottom: meta
(repo · task · scope · age) on the left, actions on the right; the assignment
select joins the action group. The reason textarea is hidden until an action
with `requiresReason` is clicked, then expands and takes focus. The fixed
three-column grid is removed; the row is a flex column with the bottom band
wrapping at narrow widths.

**New task drawer.** A segmented control at the top: `Plan from source`
(the former Plan work form) / `Write directly` (the former New task form).

## Compatibility

- Removing `path` from API responses and refusing it on input is a breaking
  API change. There are no external consumers today (the hosted control plane
  is still in issues), so no deprecation window.
- Both startup migrations are idempotent and safe to run on every start.
- The `default` repository id disappears. Anything that hard-codes
  `repoId: "default"` (CLI flags, tests, demo scripts) must pass a real id or
  omit it.

## Testing

- `src/web/repositories.ts`: URL-only registration; `path` input → 400; home
  migration creates exactly one entry and is idempotent; home without
  `origin` registers nothing; re-registering the migrated URL is a duplicate.
- `src/skills/load.ts`: global path resolution; error message names the
  global path; migration copies, skips identical, refuses on conflict without
  overwriting.
- `src/providers/descriptors.ts`: every descriptor has `role` and `auth`.
- Console view model (`support.js` or a new pure module): `primaryAction`,
  stepper derivation, inbox reason visibility — table-driven unit tests.
- Full suite on the Linux box; macOS cannot pass the path-anchoring tests.

## Delivery

Five independently mergeable PRs:

1. **repo** — home/repository split, `--home`, URL-only registration,
   `default` retirement + migration, Repos page and form without path.
2. **skills** — global skills, migration, Skills page without repository.
3. **providers** — `role`/`auth` descriptors, Settings page with three
   sections.
4. **nav** — sidebar reduction, Scheduler/Stability/Preview removal, Tasks
   filter chips, New task drawer merge, Dashboard attention card.
5. **task-detail + inbox** — primary action, overflow menu, stepper, metadata
   reduction, Evidence block; Inbox two-band layout.

PRs 1–3 touch the data layer and are independent of each other. PR 4 depends
on 1 (Repos page) and 3 (Providers page). PR 5 is independent of 4.

## Open item

**Factory Queue UI placement.** The Scheduler page was its only surface. The
queue, its API, and the webhook intake path stay as they are. Default for
this design: no console surface. Candidate alternative when needed: render
`needs_human` candidates as Inbox items.
