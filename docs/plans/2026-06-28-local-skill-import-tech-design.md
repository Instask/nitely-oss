# Local Skill Import Tech Design

## Scope

Implement issue #303 as a CLI-first local skill import. The import command writes into `.nitely/skills/<skill-id>/`, after which existing Web Console skill discovery and run-time skill loading continue to work unchanged.

## CLI Contract

```bash
nitely skill import ./my-skill --repo /path/to/repo
nitely skill import ./my-skill/SKILL.md --repo /path/to/repo
nitely skill import ./my-skill --repo /path/to/repo --overwrite
```

Output:

```text
SKILL imported <skill-id>
Target: .nitely/skills/<skill-id>
Hash: <sha256>
Resources: <n>
```

## Implementation Plan

### `src/skills/load.ts`

- Export a validation helper that can parse and validate a skill directory without copying resources into a run snapshot.
- Reuse the existing frontmatter parser and resource collector.
- Keep run-time error semantics unchanged.

### `src/skills/import.ts`

- Add `importLocalSkill(input)`:
  - Resolve source path.
  - If source is `SKILL.md`, treat its parent as source root but only copy `SKILL.md`.
  - If source is a directory, require `SKILL.md` inside it and copy all non-symlink resource files.
  - Parse `frontmatter.name` as the target skill id.
  - Reject invalid identifiers.
  - Validate source using the same parser/resource checks as run-time loading.
  - Reject existing target unless `overwrite` is true.
  - Copy into a temporary sibling directory under `.nitely/skills`, then rename into place.
  - Return id, content hash, relative target path, and resource count.

### `src/cli.ts`

- Add command parsing for `skill import <path> --repo <repo> [--overwrite]`.
- Print deterministic import metadata.
- Return non-zero with the validation error on invalid input.

## Safety

- Source symlinks are rejected before copying.
- Target path is derived only from validated `frontmatter.name`.
- Target writes are constrained under `<repo>/.nitely/skills`.
- Existing target is protected unless `--overwrite` is set.
- The command avoids partial visible targets by copying into a temporary directory first.

## Tests

- Add focused tests in `test/skills/import.test.ts`.
- Add CLI coverage in `test/cli.test.ts`.
- Reuse `loadStageSkills` after import to prove run-time loading still works.

## Follow-Ups

- Web import UI with preview and confirmation.
- `.skill` packaged bundle format.
- Optional flow editor integration to select newly imported skills.
