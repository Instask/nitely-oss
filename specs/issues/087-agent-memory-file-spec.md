# Issue 87: Per-Repo Agent Memory File Generator

## Background

Nitely runs each agent stage as a cold-start subprocess (`codex exec`, `claude -p`,
`glm chat`) in the run worktree. On every run, agents re-discover the same stable
repository facts — layout, build/test/lint commands, conventions — by issuing
grep/glob/read tool calls inside their own loop. This "B-class" token cost happens
*inside* the agent subprocess and is invisible to, and uncappable by, Nitely from
the outside.

The #65 MVP already reduced "A-class" cost (input-artifact delivery: metadata +
readable path + 8 KiB head preview instead of full inline, plus
`stage.context.usage` observability). B-class repo re-exploration remains open.

Industry agents converge on a lightweight answer: a per-repo **memory file** that
the runtime loads automatically. `codex exec` loads `AGENTS.md`; `claude -p`
(without `--bare`) loads `CLAUDE.md`. Generating and reusing such a file lets
Nitely cut cold-start re-exploration without changing prompt assembly, and keeps
the content human-inspectable rather than relying on lossy summarization.

## Goal

Generate a per-repo agent memory file, cache it at repo scope keyed by a
structural fingerprint, and make it available to each run's agents through the
runtime's native memory-file loading — without modifying `renderPrompt` and
without committing the file into the user's repository.

## Definitions

- **Agent memory file**: a Markdown file the agent runtime loads automatically —
  `AGENTS.md` for codex, `CLAUDE.md` for claude.
- **Structural fingerprint**: a deterministic hash over dependency manifests,
  shallow top-level directory structure, and key config files. Changes when the
  repo's shape changes, not on ordinary source edits.
- **Knowledge cache**: repo-scoped storage under `.nitely/knowledge/` holding the
  generated memory content and its fingerprint metadata.

## Requirements

1. Nitely must compute a deterministic structural fingerprint of the repository.
   Inputs must include, when present: dependency manifests (e.g. `package.json`,
   `pnpm-lock.yaml`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `requirements.txt`,
   `Gemfile`), the top-level directory structure to a fixed shallow depth, and key
   config files (e.g. `tsconfig.json`). Ordinary source edits that change none of
   these must not change the fingerprint.
2. Generated memory content must be cached at repo scope under
   `.nitely/knowledge/`, persisting across runs, recording at least the
   fingerprint, generation timestamp, and the runtime/model used.
3. At run start, Nitely must compare the current fingerprint to the cached one:
   on a hit, reuse the cached content with no generation cost; on a miss (absent
   or changed), generate fresh content before agent stages run.
4. Generation must produce a deterministic skeleton (top-level layout, detected
   dependencies, and build/test/lint commands) with no LLM cost. Optional
   agent/LLM enrichment of high-level architecture and conventions may be layered
   on top; when enrichment runs it uses the run's first agent stage runtime/model.
5. Before agent stages run, Nitely must make the cached content available at the
   worktree root as the runtime-appropriate filename(s): `AGENTS.md` and
   `CLAUDE.md`. Both filenames must be provided so codex and claude stages both
   benefit.
6. An injected memory file must never enter the published change. Nitely must
   remove the injected `AGENTS.md`/`CLAUDE.md` from the worktree before
   `commitAll`, OR otherwise guarantee it is excluded from the commit. (The
   worktree root is not under `.nitely/`, so `git add .` would otherwise stage
   it.)
7. If the repository already contains a tracked `AGENTS.md` or `CLAUDE.md`, Nitely
   must not overwrite or remove the user's file. Nitely-managed injection applies
   only when the corresponding file is absent from the checked-out worktree.
8. Nitely must not pass `--bare` to `claude -p`, since `--bare` skips `CLAUDE.md`
   loading. This must be covered so a future change cannot silently disable claude
   memory loading.
9. Generation or injection failure must degrade gracefully: the run proceeds with
   no memory file injected (current behavior). It must never fail or block a run.
10. Generation must emit a durable event (e.g. `knowledge.generated`) recording
    runtime/model, fingerprint, and content path, so the cost is auditable and
    future token accounting can attribute it.
11. Deleting `.nitely/knowledge/` must force a clean regeneration on the next run
    with no other side effects.

## Out Of Scope

- Heavy repository knowledge graph / code indexer with query APIs (tracked in
  #20). This issue is a lightweight, complementary first step.
- Committing the memory file into the user's repository.
- Budget enforcement, caps, or per-stage budget fields (separate #65 follow-up).
- Memory loading for the `glm` runtime (it does not load AGENTS.md/CLAUDE.md;
  glm stages simply do not benefit and must not break).
- Changing `renderPrompt` or the prompt assembly path.

## Acceptance Criteria

1. A deterministic fingerprint function returns a stable value for unchanged
   structural inputs and a different value when a dependency manifest changes;
   editing a non-structural source file does not change it.
2. On a cache miss, memory content is generated and persisted under
   `.nitely/knowledge/` with fingerprint, timestamp, and runtime/model recorded.
3. On a cache hit (matching fingerprint), no enrichment agent is spawned.
4. A changed structural fingerprint triggers regeneration on the next run.
5. The deterministic skeleton is produced with no agent/LLM invocation; a run with
   enrichment disabled still injects a usable skeleton memory file.
6. Before agent stages run, both `AGENTS.md` and `CLAUDE.md` exist at the worktree
   root with the cached content (when no user-tracked file is present).
7. After a run that injected a memory file, the published change (commit) does not
   contain the injected `AGENTS.md`/`CLAUDE.md`.
8. A worktree that already has a tracked `AGENTS.md`/`CLAUDE.md` is left untouched
   (content and git status unchanged for that file).
9. The claude runtime invocation does not include `--bare` (regression-guarded).
10. A generation or injection failure leaves the run running normally with no
    memory file and no run-failing error attributable to this feature.
11. A `knowledge.generated` event is recorded and projectable for runs that
    generated content.
12. Deleting `.nitely/knowledge/` causes a clean regeneration on the next run.
13. Focused tests and the full validation suite (`pnpm exec vitest run`,
    `pnpm run check`, `pnpm run build`) pass.
