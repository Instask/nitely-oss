# Hybrid retrieval benchmark

Run the self-contained smoke comparison with:

```sh
nitely benchmark hybrid-retrieval --fixture benchmarks/hybrid-retrieval.fixture.json --budget 1800 --output /tmp/hybrid-report.md
```

The default fixture is bundled in the CLI, so installed packages do not need the
repository fixture file. `--output` is written even for a no-go; exit status 1
means no-go or an invalid invocation. The result also exposes a structured
`decision` field. Fixtures require a nonempty document corpus, unique question
IDs, existing expected source paths, and explicit out-of-repository questions.

The comparison executes the existing knowledge engine's BM25 lexical retrieval
and its BM25 + local-hash vector ranking fused with RRF against the same corpus
and per-query budget. It measures expected-path recall (including abstention),
source text/range/revision/hash validity, retrieval latency and the token estimate
of the full escaped prompt payload. Index construction is outside query latency;
timings vary by machine. The fixture digest identifies the evaluated inputs.
Local-hash vectors are lexical features, **not semantic embeddings**.

The committed fixture contains public-code-shaped smoke examples, not observed
spec-to-PR outcome evaluations. These measurements cannot establish value over
repo-index or file grep. Semantic retrieval, realistic failure/overfetch cases,
recency/importance weighting, cold indexing cost and downstream code/eval outcomes
still need evaluation. Consequently this benchmark always reports **no-go**;
passing unit tests or a smaller context cannot authorize rollout or close the
associated evaluation work.

## Experimental Run integration

`NITELY_HYBRID_RETRIEVAL=1` adds task-repository retrieval to actual agent and
review-gate prompt preparation. It reuses the existing knowledge chunker, BM25,
local-hash embedding, RRF and untrusted passage renderer. Default behavior is
unchanged. This is an experiment, not a claim that semantic retrieval is ready.

The corpus is limited to committed regular Git blobs in the task repository at
the execution worktree HEAD (using the original repository context policy). It ignores worktree changes, symlinks and submodules, honors
`nitely.context.json` and the stage's read-deny/file-size limits, and omits
sensitive source material using the existing context redaction boundary. No
network request, sidecar, disk index, knowledge proposal write or authoritative
memory mutation is performed. Disabled/isolated contexts and explicit knowledge
attachment selections are not widened by the flag. Retrieval errors emit degraded evidence and preserve attached context in
`degraded-ok` mode; `required` mode fails the attempt.

Retrieved passages supplement existing evidence, pass through its existing
prompt-budget trimming, and are recorded as `knowledge.retrieved` evidence with
reason code `task-repository-lexical-hash`. Flow inputs and context storage remain
authoritative. The standalone packer exposes `context`, the exact escaped string
whose estimate is constrained by the budget; rejected records expose locators
only. This is an approximate tokenizer budget, not a model-specific token count.

## Smoke result (2026-10-18)

Fixture digest: `sha256:4fab0b747f21baec842019a3253a1dba575d25554419be26a3c27fab941e65ce`.
Per-query budget: 1,800 estimated tokens; six questions, five documents.

| Measurement | BM25 baseline | BM25 + local-hash RRF |
| --- | ---: | ---: |
| Expected-path recall, five repository questions | 1.0 | 1.0 |
| Out-of-repository abstention, one question | Passed | Passed |
| Source range/revision/hash verification | Passed | Passed |
| Total rendered context tokens | 1,186 | 1,258 |

There is no quality improvement on these smoke questions and context consumption
increases by 72 estimated tokens. Query latency is emitted per question by the
command and must be measured on the intended machine; the smoke latency excludes
index construction. **Decision: no-go**. This result supports keeping the
experiment opt-in and leaving the broader evaluation work open.
