# Issue 303 Spec: Local Skill Import

## Problem

Nitely can load custom skills from `.nitely/skills/<skill-id>/SKILL.md`, but users must manually copy locally debugged skill directories into each target repository. This is error-prone and makes reusable local skills harder to adopt across repositories.

## Goals

- Add a CLI-first import path for local custom skills.
- Reuse the same skill validation rules used by run-time loading.
- Keep the feature local-first, with no hosted registry or marketplace dependency.
- Preserve existing `/api/skills` discovery behavior after import.

## User Stories

- **US-001:** As a developer, I can run `nitely skill import ./my-skill --repo /path/to/repo` and copy a validated skill directory into the target repository.
- **US-002:** As a developer, I can run `nitely skill import ./my-skill/SKILL.md --repo /path/to/repo` and import a single-file skill.
- **US-003:** As an operator, I can see whether import changed the target by reading a deterministic content hash.
- **US-004:** As a reviewer, I can trust that symlinks, unsafe paths, malformed frontmatter, and accidental overwrites are rejected before a partial import is left behind.

## Functional Requirements

- **FR-001:** Add `nitely skill import <path> --repo <repo>` to the CLI.
- **FR-002:** Accept either a single `SKILL.md` file or a directory containing `SKILL.md`.
- **FR-003:** Derive the skill id from `frontmatter.name`.
- **FR-004:** Validate `name`, `description`, non-empty body, identifier format, and name-to-directory consistency using the existing run-time skill rules.
- **FR-005:** Copy resources from a source directory while rejecting symlinks and paths that escape the source root.
- **FR-006:** Protect existing target skills unless `--overwrite` is supplied.
- **FR-007:** Write the imported skill to `<repo>/.nitely/skills/<skill-id>/`.
- **FR-008:** Print the imported skill id, target path, deterministic content hash, and resource count.
- **FR-009:** Imported skills must appear in the existing `/api/skills` listing without additional registration.

## Non-Goals

- No Web upload/import UI in this slice.
- No `.skill` zip/tar bundle format in this slice.
- No hosted marketplace, registry, or organization-wide catalog.
- No automatic flow editing after import.

## Success Criteria

- Valid file and directory imports work from the CLI.
- Existing target skills are protected by default.
- `--overwrite` replaces the target atomically enough to avoid mixed old/new contents.
- Invalid skills and unsafe resources fail before target mutation.
- Tests cover import success, overwrite protection, malformed skills, symlink resources, and run-time loading after import.
