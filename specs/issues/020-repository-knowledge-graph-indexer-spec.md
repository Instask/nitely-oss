# Issue 20 Repository Knowledge Graph Indexer Spec

## Scope

Build the first local-first repository indexer so Nitely agents can discover relevant files and symbols without reading broad repository context into prompts.

## User Stories

- **US-001:** As an implementation agent, I can query related files for a path or symbol so I can inspect a small target set before editing.
- **US-002:** As a reviewer, I can see which repository graph queries were used as run evidence.
- **US-003:** As an operator, I can rebuild the local repository index from the CLI.

## Functional Requirements

- **FR-001:** Nitely must build a repository index from the CLI and store it under `.nitely/repo-index.json`.
- **FR-002:** The index must include directories, files, imports, imported-by relationships, and exported/function/class symbols when detectable with lightweight parsing.
- **FR-003:** The indexer must skip files omitted by context policy, including built-in secret exclusions and warn-only paths.
- **FR-004:** Nitely must expose a query API and CLI command that returns related files for a path or symbol query.
- **FR-005:** Query results must identify why a file matched, including direct path, symbol, import, imported-by, or historical-run signals.
- **FR-006:** CLI queries may record graph-query evidence against a run when run id, stage id, and attempt are supplied.
- **FR-007:** Query results must report when an index is stale relative to indexed file mtimes.

## Success Criteria

- **SC-001:** `nitely repo-index build --repo <path>` writes an index and reports file/symbol counts.
- **SC-002:** `nitely repo-index query --repo <path> <target>` returns related files from the stored index.
- **SC-003:** Context-excluded and warn-only files do not appear in the index.
- **SC-004:** Tests cover indexing, related-file queries, stale detection, and run evidence events.

## Non-Goals

- Full TypeScript AST semantic analysis.
- Cross-language call graph precision.
- Cloud-hosted index storage.
- Automatic prompt rewriting in every flow.
