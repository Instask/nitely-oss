# Hybrid retrieval benchmark

`nitely benchmark hybrid-retrieval --fixture benchmarks/hybrid-retrieval.fixture.json`
runs the local, deterministic comparison and can write the report with
`--output <path>`. The packer uses caller-supplied snippet text, a documented
four-byte-per-token estimator, and a fixed provenance envelope. It records
invalid, dropped, and sanitized candidates without reading candidate paths.

Hybrid ranking is opt-in with `NITELY_HYBRID_RETRIEVAL=1`; an unset flag keeps
the existing Flow evidence context path unchanged. Benchmark proposals are
report-only and are not written to authoritative memory or Flow evidence.
