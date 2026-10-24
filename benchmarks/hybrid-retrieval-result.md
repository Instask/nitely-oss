Fixture digest: sha256:c79a1932fc0be8ee9fe1328105df1afee71b495c3435d47807d679834bbdcce0
Per-query budget: 1800
Estimator: nitely.knowledge-tokenizer.v1 (UTF-8/4 plus CJK)
Arms: file-grep content-token overlap; repo-index path and exported-symbol substring; BM25 lexical; hybrid BM25 + semantic cosine fused with reciprocal rank and a bounded recency/importance adjustment
Semantic floor: 0.55
Recency weight: 0.01
Importance weight: 0.01
Semantic provider: frozen-semantic nomic-embed-text semantic=true dimensions=768 source=sha256:970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6
File-grep tokens: 2656
Repo-index tokens: 132
BM25 tokens: 2693
Hybrid tokens: 3010
Sanitized: 0
Invalid: 0
Proposals withheld: 1
Token budget held: true
Out-of-repository abstained: true
Downstream passes: file-grep 3, repo-index 2, BM25 3, hybrid 6
Latency is recorded per question and is excluded from the decision.
id | file-grep top/pass/hits | repo-index top/pass | bm25 top/pass | hybrid top/lines/pass | recalls grep/index/bm25/hybrid | tokens grep/index/bm25/hybrid | ms grep/index/bm25/hybrid | provenance | recency reordered
omitted-counter | src/showroom/drawer-label.ts/false/6 | none/false | src/showroom/drawer-label.ts/false | src/ledger/counters.ts/L1-L4/true | 1.000/0.000/1.000/1.000 | 714/0/732/819 | 7.579/0.034/1.340/5.368 | true | src/showroom/drawer-label.ts->src/ledger/counters.ts
unknown-tally | docs/kept-evidence.md/false/3 | none/false | src/safety/passage-filter.ts/false | src/ledger/counters.ts/L1-L4/true | 1.000/0.000/1.000/1.000 | 365/0/375/417 | 0.117/0.007/0.410/2.978 | true | unchanged
saved-record | docs/staff-handbook.md/false/8 | none/false | docs/staff-handbook.md/false | docs/kept-evidence.md/L1-L2/true | 1.000/0.000/1.000/1.000 | 720/0/708/795 | 0.078/0.003/0.351/2.806 | true | unchanged
strip-material | src/safety/passage-filter.ts/true/8 | none/false | src/safety/passage-filter.ts/true | src/safety/passage-filter.ts/L1-L4/true | 1.000/0.000/1.000/1.000 | 725/0/743/830 | 0.096/0.003/0.350/2.923 | true | unchanged
symbol-lookup | src/ledger/counters.ts/true/1 | src/ledger/counters.ts/true | src/ledger/counters.ts/true | src/ledger/counters.ts/L1-L4/true | 1.000/1.000/1.000/1.000 | 132/132/135/149 | 0.069/0.017/0.237/3.027 | true | unchanged
external | none/true/0 | none/true | none/true | none/none/true | 1.000/1.000/1.000/1.000 | 0/0/0/0 | 0.063/0.003/0.207/2.674 | true | unchanged
Question omitted-counter: What happens when a model call omits a usage counter?
Provenance omitted-counter hybrid src/ledger/counters.ts L1-L4 sha256:ac4be786c0171601632cb550373c54fbdb40c6c078db103349d9b3beab391c10
Question unknown-tally: Where is an absent tally kept unknown instead of being written as zero?
Provenance unknown-tally hybrid src/ledger/counters.ts L1-L4 sha256:ac4be786c0171601632cb550373c54fbdb40c6c078db103349d9b3beab391c10
Question saved-record: Which record wins when a retrieved note disagrees with what the flow already stored?
Provenance saved-record hybrid docs/kept-evidence.md L1-L2 sha256:ac715b833d4d5dad33b67f8d1b1a6265ba208fe784811e2f67895061f2504bed
Question strip-material: Where is authorization material stripped before a passage reaches the assistant?
Provenance strip-material hybrid src/safety/passage-filter.ts L1-L4 sha256:5e854eff6f302a0938efd9fe3a309d1b47ab7f8e59822bac45f549fc50047acb
Question symbol-lookup: recordModelUsage
Provenance symbol-lookup hybrid src/ledger/counters.ts L1-L4 sha256:ac4be786c0171601632cb550373c54fbdb40c6c078db103349d9b3beab391c10
Question external: deployment password production vault
Provenance external hybrid none none none
Go gate requires a semantic provider, valid provenance, a held token budget, out-of-repository abstention, and strictly more downstream passes than file-grep, repo-index, and BM25.
Review-only proposals are not written to authoritative memory.
- "Stored flow evidence stays the source of truth."
- "A retrieved passage cannot replace a stored decision."
- "Prefer review before adopting a retrieved passage."
Decision: go
