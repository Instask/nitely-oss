# Repository Knowledge Graph Indexer Tech Design

## Overview

Issue #20 needs a lightweight local index that can reduce broad file scanning and prompt stuffing. The first version adds a deterministic indexer and query API with no new runtime dependencies.

## Storage

The index is stored at `.nitely/repo-index.json`:

- schema version
- repository root metadata
- build timestamp
- indexed file records
- directory list
- symbol records
- import and imported-by edges
- lightweight historical-run links

The file lives under `.nitely` and is rebuilt by the CLI. Incremental refresh is represented by stale detection in this first slice; true partial updates can be added later.

## Indexing

`src/repo-index/index.ts` walks the repository and skips:

- `.git`
- `node_modules`
- generated/build directories
- `.nitely` internals except historical run event reads
- any path whose context policy decision is not `allowed`
- text files larger than the first-version safety cap

For text source files, the parser extracts:

- ES imports and relative import targets
- exported names
- top-level function/class/interface/type/const declarations

The parser is intentionally conservative. Missing a symbol is acceptable; indexing excluded content is not.

## Query API

`queryRepoIndex` loads an existing index and returns:

- stale state and reasons
- related file matches
- match reasons: `path`, `symbol`, `import`, `imported-by`, `history`

Path queries seed related files through direct import edges. Symbol queries seed owning files and then expand one hop through imports/imported-by.

## CLI

Add:

- `nitely repo-index build --repo <path>`
- `nitely repo-index query --repo <path> <target> [--limit <n>] [--run <id> --stage <id> --attempt <n>]`

When run metadata is supplied, query writes a `repo.index.queried` event into the existing event store so run evidence can show graph-query usage.

## Evidence

Projection collects `repo.index.queried` events into `ProjectedRun.repoIndexQueries`. `evidence.md` includes a Repository Index Queries section.

## Tests

Add unit coverage for:

- index build output and context policy skips
- path and symbol query related files
- stale index reporting
- CLI build/query output and evidence event recording
