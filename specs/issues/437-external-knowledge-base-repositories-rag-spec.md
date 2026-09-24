# Issue 437: External Knowledge-Base Git Repositories For RAG

## Problem

Nitely can index the repository being changed and can inject approved,
repository-local context-knowledge entries. It cannot attach a separate Git
repository as a read-only knowledge source. As a result, specification,
technical-design, implementation, and review stages cannot consistently reuse
organization standards, platform contracts, runbooks, or architecture guidance
that deliberately live outside the target repository.

A knowledge repository is not another implementation checkout. Its content is
untrusted reference material: it must be pinned, filtered, bounded, cited, and
kept outside the agent's writable worktree.

## User-visible behavior

- An operator can attach a local or remote Git repository to one Nitely target
  repository, provide the branch, tag, or commit ref to follow, configure
  include/exclude globs, and
  choose whether the attachment is required.
- Nitely resolves every refresh to an immutable commit SHA, reads Git objects
  from a managed bare mirror without checking files into an agent worktree, and
  publishes a new index atomically only after the complete snapshot succeeds.
- The target repository's effective `nitely.context.json` policy and the
  attachment's include/exclude policy are applied before text is stored or sent
  to an embedding provider. Built-in secret paths, symbolic links, submodules,
  binary files, oversized files, and sensitive-looking content are not indexed.
- Every indexed chunk has stable source identity: attachment id, commit SHA,
  repository-relative path, line range, and content digest.
- Retrieval combines Unicode-aware lexical ranking and semantic vector
  similarity with deterministic tie-breaking. CJK text is searchable without
  requiring whitespace tokenization.
- A deterministic local feature-hash fallback is available without credentials
  and is reported as lexical-only rather than semantic. Production semantic
  retrieval can use a loopback Ollama embedding model or an administrator-owned
  OpenAI-compatible provider; credentials and endpoints are never supplied by
  attachment content.
- Specification drafting, technical-design drafting, agent stages, and review
  gates retrieve against their actual source/spec/stage prompt and declared
  artifact contents. Results are bounded by top-k and prompt-token budgets.
- Retrieved passages are placed in an explicit untrusted-reference section.
  They cannot override Flow instructions, project instructions, policy, output
  contracts, or approval gates.
- Generated specs and technical designs contain a compact `Knowledge Sources`
  section. Run evidence records metadata-only retrieval events and the exact
  citations injected into each stage.
- CLI and Web API operations support attach, list/status, refresh, query, and
  detach. Existing repositories and Flows continue to work when no attachment
  exists.

## Attachment contract

The target-scoped registry is versioned and stores no credentials. Registry,
mirror, and index state live below
`<knowledge-runtime-root>/targets/<target-key>/`, keyed by the canonical target
repository identity, not in the target Git worktree. Each attachment contains:

- stable `id` and operator-facing `name`;
- `source.type` (`local` or `remote`) and a sanitized source locator;
- an explicit followed `ref` with type `branch`, `tag`, or `commit` (there is no
  implicit remote-default-branch or local-`HEAD` fallback);
- include and exclude globs;
- `enabled` and `required` flags;
- refresh policy plus bounded indexing/chunking and retrieval limits (including
  `topK` and `maxPromptTokens`);
- embedding provider id and model (provider endpoints are administrator-owned,
  not attachment-controlled).

The separate target-scoped status record contains the last successful snapshot
metadata: snapshot id, commit SHA, index digest, policy fingerprint,
provider/model and non-secret provider-configuration digest, file/chunk counts,
and completion time. It also carries sanitized failure and stale state.

Attachment ids, including Flow `externalKnowledge.ids`, are lowercase safe path
segments matching `[a-z0-9][a-z0-9_-]{0,63}`. Web attach decoding rejects
unknown source/ref variants and non-boolean `enabled`/`required` values instead
of coercing them. Remote URLs containing userinfo are rejected. The registry and
API never persist or return tokens, passwords, authorization headers,
credential-helper output, or environment values.

## Snapshot and indexing contract

Refresh follows these rules:

1. Create or reuse a managed bare repository below the target-scoped Nitely
   runtime-state root, outside the target and agent worktrees.
2. Fetch only through an explicit Git subprocess with hooks disabled and
   interactive credential prompting disabled. Resolve the requested ref to a
   full commit SHA.
3. Enumerate the commit tree. Accept only regular blobs whose paths pass both
   policies and whose extension, object size, and decoded content fit bounded
   text rules. Skip symbolic links and gitlinks without dereferencing them.
4. Reject content detected as sensitive before chunking or embedding. Skipped
   content is neither retained nor returned; any surfaced failure state is
   sanitized and never includes that content. Status may expose aggregate
   accepted/policy/sensitive/unsupported counts, but not skipped paths or text.
5. Chunk accepted text on line/paragraph boundaries with bounded overlap and
   compute stable ids from attachment, commit, path, line range, and content.
6. Compute lexical statistics and vectors. Remote embedding requests are
   bounded and contain only policy-approved chunk text.
7. Under cross-process registry/attachment/mirror leases plus a monotonic
   refresh-generation fence, write a versioned index to a temporary sibling and
   atomically publish it.
   Update the status record's successful-snapshot pointer only after
   publication and a refresh-generation fence check.

A failed refresh leaves the previous successful snapshot queryable and records
only a sanitized failure status. A required attachment with no usable snapshot
fails generation or stage execution clearly; an optional attachment degrades
with evidence.

## Retrieval contract

The query is built at the point of use:

- spec draft: source title/body, planning guidance, and selected Flow path;
- technical-design draft: approved spec plus lightweight target-repository
  context;
- agent/review stage: stage id, stage prompt, Flow name, configuration keys,
  and the inlined text of the stage's declared input artifacts; and
- explicit query: operator-supplied text.

Before lexical scoring or query-vector construction, Nitely redacts known
environment/provider secrets and rejects an empty or still-sensitive structured
query. Retrieved passage text is redacted and sensitive matches are omitted
again before the service returns them; Web planning applies the same boundary a
second time before generated-artifact input.

The lexical scorer uses Unicode-normalized terms, character n-grams for CJK,
document frequency, and length normalization. The semantic scorer uses cosine
similarity only for vectors produced by a declared semantic provider. The local
feature-hash fallback is reported as a lexical projection and is never reported
as semantic retrieval. Lexical and vector rankings are combined with
deterministic reciprocal-rank fusion. Duplicate chunk content is collapsed,
filters are applied before scoring, and final ties sort by attachment id,
commit, path, line, then chunk id.

Every result exposes:

- a display citation such as `kb://standards/<sha>/docs/api.md#L20-L44`;
- attachment id/name, immutable commit, path, and line range;
- lexical, semantic, and combined score;
- bounded passage text; and
- the index/provider identity used for the decision.

## Flow context contract

`spec.context.externalKnowledge` and stage-level
`stage.context.externalKnowledge` accept either a boolean or an object with
`enabled`, attachment `ids`, `topK`, `maxPromptTokens`, and `availability`
(`required` or `degraded-ok`). Object values merge flow-to-stage using id
intersection, smaller limits, and required-wins availability. It defaults on
for non-isolated agent/review stages and off for isolated stages. Setting it to
`false` guarantees that no knowledge index is queried and no passage is
injected for that stage.

At run admission Nitely persists a `KnowledgeSnapshotSet` containing, for each
selected attachment, its id, snapshot id, commit, index digest, policy
fingerprint, provider id/model/configuration digest, pinned retrieval limits,
attachment-configured required flag, and run-admission required flag. Keeping
those flags distinct prevents one stage's required scope from promoting the
same attachment in an optional stage, while an attachment configured globally
required remains fatal everywhere. The pin deliberately contains no index or
mirror filesystem path.
Every stage and resume reads only that pinned set; resume verifies the run-owned
sidecar exactly against the admission evidence before using it. Refresh may move
the current registry pointer, while detach atomically removes the registry
relationship but retains an unreachable status tombstone, immutable indexes,
and mirrors so an in-flight pinned run remains readable. A same-id reattach
atomically overwrites that tombstone with a fresh status and cannot inherit the
old snapshot.

Attachment `topK` and `maxPromptTokens` are copied into the run pin. A query's
aggregate request limits are clamped to the smallest corresponding limit among
the selected pins, so neither Flow/stage controls nor an explicit caller can
expand the admitted attachment budgets. Packing measures the final escaped and
framed XML/Markdown representation after boundary redaction, not raw passage
text, so entity expansion and per-line quoting cannot bypass the cap.

Knowledge passages are rendered after governing instructions and before output
contracts under these rules:

- the section states that passages are untrusted reference material;
- each passage is delimited and carries its immutable citation;
- passage text is redacted again at prompt/evidence boundaries;
- the section never claims that a retrieved passage is authoritative; and
- ordinary prompt-budget trimming may reduce passage count or body size, but it
  must preserve citations for every remaining passage.

## CLI and Web API

```text
nitely knowledge-repo attach --repo <target> --id <id> --name <name> --source <path-or-github-url> --ref <ref> [--ref-type branch|tag|commit] [--include <glob>] [--exclude <glob>] [--required] [--embedding-provider local-hash|ollama|openai-compatible] [--embedding-model <model>]
nitely knowledge-repo list --repo <target> [--json]
nitely knowledge-repo status --repo <target> <id> [--json]
nitely knowledge-repo refresh --repo <target> <id>
nitely knowledge-repo query --repo <target> <query> [--attachment <id>] [--limit <n>] [--max-prompt-tokens <n>] [--json]
nitely knowledge-repo detach --repo <target> <id>
```

Web exposes equivalent repository-scoped operations under
`/api/knowledge-repositories`. Until Web has a repository ACL model, all
knowledge lifecycle and query operations require administrator access (local
auth mode remains the single trusted operator) and participate in the existing
security-action/audit boundary. Web planning automatically uses optional
knowledge only for an interactive administrator; for a non-administrator it
omits optional knowledge and rejects planning when an enabled attachment is
required. Starting, scheduling, or resuming a Flow that selects external
knowledge also requires an interactive administrator; API-token identities do
not satisfy that boundary.

Remote attach/refresh, explicit query, planning retrieval, and Flow admission
use the authenticated user's provider-store context rooted at the Nitely home
repository. Before a selected remote attachment is used, a stored GitHub
credential's repository, organization, external-vault organization, or user
ownership scope must match the selected target repository/current
organization/current user. The access token itself is requested only when a
remote Git fetch is needed.

## In scope

- Versioned attachment registry and atomic status updates.
- Local and GitHub HTTPS Git sources resolved to immutable commits in managed
  bare mirrors. Private GitHub reads may use a scoped GitHub provider connection
  injected by the caller without persisting it.
- Policy-aware, bounded text extraction and stable chunking.
- Unicode lexical search, local vectors, an OpenAI-compatible real embedding
  provider path, a loopback Ollama provider path, and hybrid ranking.
- CLI and Web API lifecycle/query operations.
- Spec draft, technical-design draft, agent-stage, and review-gate retrieval.
- Citations, prompt-injection framing, metadata-only events, and run evidence.
- Focused security, determinism, CJK, integration, CLI, and Web tests.

## Out of scope

- Training, fine-tuning, or automatically editing the knowledge repository.
- Granting knowledge content instruction priority or using it to bypass an
  approval, capability, context, or sandbox policy.
- Background schedulers, webhooks, incremental object-delta indexing, or a
  shared multi-tenant vector service in the first slice.
- Arbitrary Git protocols, SSH/SCP sources, or attachment-selected embedding
  endpoints. Private GitHub reads use an injected provider connection;
  embedding credentials/endpoints use administrator environment/provider
  configuration and are never stored in attachment documents.
- Indexing submodule targets, Git LFS payload downloads, generated binaries,
  images, archives, or arbitrary office formats.

## Acceptance checks

1. Attaching a local or remote source creates a credential-free registry record,
   resolves a commit, and builds a queryable immutable index without adding a
   checkout to an agent worktree.
2. Invalid ids/refs/globs, URL userinfo, path escape, symbolic links, gitlinks,
   binary/oversized blobs, policy-excluded paths, and sensitive content never
   enter the index or embedding request.
3. A failed refresh preserves the prior index; cross-process concurrent or
   partial writes never expose malformed JSON or lose another registry update.
4. The same snapshot/configuration produces stable chunk ids, ordering, and
   index digests.
5. English and CJK fixtures are found lexically; an Ollama/OpenAI-compatible
   fixture proves real semantic plus lexical hybrid ranking with deterministic
   ties and duplicate collapse. Local-hash is visibly degraded/lexical-only.
6. Semantic providers send only approved bounded text, read credentials and
   allowlisted endpoints at call time, reject malformed responses, and never
   persist or emit credentials.
7. Spec and technical-design drafts use their full source/spec query and include
   immutable knowledge citations when relevant.
8. Every non-isolated agent/review stage queries using its own prompt and
   declared input content. Disabled/isolated stages perform no retrieval.
9. Prompt text labels passages as untrusted, preserves governing instruction
   priority, fits configured budgets, and includes a citation for every injected
   passage.
10. `knowledge.retrieved` evidence identifies run/stage/attempt, keyed query
    fingerprint,
    index/commit, citations, ranks, scores, and truncation counts without query
    bodies, credentials, or excluded content.
11. CLI and Web API attach/list/status/refresh/query/detach paths enforce
    validation and repository authorization with actionable failures.
12. With no attachment, all existing Flow, spec, technical-design, CLI, and Web
    behavior remains compatible and the full test/check/build suite passes.

## Failure and recovery

- Authentication, network, ref-resolution, provider, and policy failures are
  sanitized. Optional attachments retain the prior snapshot or produce an
  evidence warning; required attachments fail the requesting operation.
- Detach atomically removes the registry relationship. The old status remains as
  a tombstone that is no longer reachable through list/status APIs and is
  atomically replaced by a fresh status on same-id reattach; this avoids a
  lock-release/unlink race. Managed mirrors and immutable indexes are also
  retained for admitted run pins; reclaiming unreferenced data is a later GC
  concern.
- An index/provider mismatch is not silently repaired during query. The operator
  refreshes the attachment so stored and query vectors share the same provider,
  model, dimensions/version, and non-secret configuration digest.
- Resume performs retrieval again from the exact immutable snapshot in the
  verified run pin, so continuation never silently moves to a newer ref or to a
  same-named provider whose vector-space configuration has changed.
