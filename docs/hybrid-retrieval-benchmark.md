# Hybrid retrieval benchmark

Run the committed comparison with:

```sh
nitely benchmark hybrid-retrieval --fixture benchmarks/hybrid-retrieval.fixture.json --budget 1800 --output /tmp/hybrid-report.md
```

The same fixture is bundled in the CLI, so an installed package can run
`nitely benchmark hybrid-retrieval` without the repository file. Exit status 0
means the report's decision is `go`. Exit status 1 means `no-go` or an invalid
invocation. The report is written for both decisions and contains exactly one
line that starts with `Decision:`.

The fixture has a nonempty document corpus, unique question IDs, expected paths
that exist in the corpus, and one explicit out-of-repository question. Repository
questions carry an expected outcome sentence. Optional document fields are an
exported symbol name plus recency and importance in the range 0 to 1.

## Arms and scoring

Each question is scored four ways, at a per-query budget of 1,800 estimated tokens:

- File grep ranks documents by the number of distinct query tokens that occur in the text. The hit count is the overfetch measure. Downstream uses the top document.
- Repo index matches the full query as a case-insensitive substring of the path or the exported symbol name, using the same path and symbol reasons as `nitely repo-index query`.
- BM25 is the existing knowledge-engine lexical index.
- Hybrid retrieval fuses that BM25 ranking with cosine similarity over frozen `nomic-embed-text` vectors using reciprocal rank fusion. A passage with semantic score below 0.55 is kept only when it also has a lexical score. Recency and importance then adjust the fused score by at most one percent each.

A repository question passes downstream when the top passage's path is expected and the passage contains the expected outcome sentence. The out-of-repository question passes when the arm returns no passage. Provenance checks the chunk text, path, line range, commit, and content digest. File-grep and repo-index citations use the whole fixture document and lines `L1` through the last line. Latency is recorded per arm and is excluded from the decision because it depends on the machine.

Token estimates use `nitely.knowledge-tokenizer.v1` (UTF-8 bytes divided by 4, plus one token per CJK character), applied to the packed escaped context. Sanitized and invalid counts come from that packer. Proposal strings are redacted and listed for review. One fixture preference matches the existing sensitive-key rule and is counted as withheld. The benchmark accepts a `writeAuthoritativeContext` callback and does not call it.

The go gate requires all of the following: the semantic provider identity has `semantic=true`, every citation's provenance is valid, every arm stays inside the per-query budget, the out-of-repository question abstains, and hybrid downstream passes strictly more questions than file grep, repo index, and BM25. Anything short of that gate is `no-go`, including a run whose texts are absent from the frozen vector table.

## Frozen semantic vectors

`scripts/freeze-hybrid-embeddings.mts` embeds the normalized chunk text and the normalized question text with a loopback Ollama server and writes `src/knowledge-repositories/frozen-semantic-table.ts`. The recorded model is `nomic-embed-text`, blob `sha256:970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6`, 768 dimensions. The benchmark replays those vectors. A missing string throws, and the comparison then stays on the lexical/hash path and reports `no-go`. The benchmark command itself makes no network call.

Regenerate the table only on a machine that already has that Ollama model:

```sh
pnpm exec tsx scripts/freeze-hybrid-embeddings.mts
```

## Runtime flag

`NITELY_HYBRID_RETRIEVAL=1` still adds BM25 plus local-hash task-repository passages to agent and review-gate prompts. The default Run path is unchanged. The flag reads committed regular Git blobs at the execution worktree HEAD, honors `nitely.context.json` and the stage read-deny and file-size limits, and skips `.nitely/`, `node_modules/`, `dist/`, lock files, symlinks, submodules, and sensitive text. It does not consult the frozen vector table and does not call an embedding server. Retrieved passages remain untrusted evidence with reason code `task-repository-lexical-hash`. Flow evidence stays authoritative.

The go decision below is the benchmark result for this fixture. It leaves the default Run path unchanged.

## Published result

Artifact: [benchmarks/hybrid-retrieval-result.md](../benchmarks/hybrid-retrieval-result.md).

Fixture digest: `sha256:c79a1932fc0be8ee9fe1328105df1afee71b495c3435d47807d679834bbdcce0`.

Per-query budget: 1,800 estimated tokens. Six questions, eight documents. Semantic provider: `frozen-semantic` / `nomic-embed-text` / `semantic=true` / 768 dimensions. Sanitized: 0. Invalid: 0. Proposals withheld: 1.

| Question | File grep | Repo index | BM25 | Hybrid |
| --- | --- | --- | --- | --- |
| omitted-counter | `src/showroom/drawer-label.ts`, fail, 6 hits | none | `src/showroom/drawer-label.ts`, fail | `src/ledger/counters.ts` L1-L4, pass |
| unknown-tally | `docs/kept-evidence.md`, fail, 3 hits | none | `src/safety/passage-filter.ts`, fail | `src/ledger/counters.ts` L1-L4, pass |
| saved-record | `docs/staff-handbook.md`, fail, 8 hits | none | `docs/staff-handbook.md`, fail | `docs/kept-evidence.md` L1-L2, pass |
| strip-material | `src/safety/passage-filter.ts`, pass, 8 hits | none | `src/safety/passage-filter.ts`, pass | `src/safety/passage-filter.ts` L1-L4, pass |
| symbol-lookup | `src/ledger/counters.ts`, pass, 1 hit | `src/ledger/counters.ts`, pass | `src/ledger/counters.ts`, pass | `src/ledger/counters.ts` L1-L4, pass |
| external | abstain | abstain | abstain | abstain |

Downstream passes, counting abstention: file grep 3, repo index 2, BM25 3, hybrid 6. The three paraphrase questions pass only on the hybrid arm. `symbol-lookup` passes on every arm. `strip-material` passes on file grep, BM25, and hybrid. Packed context tokens, summed across the six questions: file grep 2,656, repo index 132, BM25 2,693, hybrid 3,010. Each question stays within 1,800. On `omitted-counter`, reciprocal-rank fusion tied the showroom distractor with the ledger passage, and the one-percent recency/importance adjustment moved the top from `src/showroom/drawer-label.ts` to `src/ledger/counters.ts` L1-L4.

Two consecutive runs of this command produced the same decision, paths, line ranges, digests, token counts, pass flags, sanitized count, invalid count, and proposal list. The latency fields differed. With the flag unset, prompt preparation returns the existing flow evidence and does not call retrieval.

**Decision: go**.
