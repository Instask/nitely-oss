# Nitely Execution

Nitely turns approved work into traceable Runs and reviewable evidence.

## Language

**Task**

The user-facing unit of planned work.

**Work item**

A durable description of work that can produce one or more Runs.

**Run eligibility**

The decision about whether a Work item may start a new Run for a particular
intent. It contains the blockers needed to explain that decision and any
blockers explicitly accepted by an operator override.

**Eligibility blocker**

A reason a new Run cannot start. A blocker is either a hard safety requirement
or a concern that an operator may explicitly accept for a manual Run.

**Run eligibility override**

An operator decision that accepts manually overridable Eligibility blockers
for one Run start. Automatic scheduling never overrides blockers.

**Run admission**

The durable single-owner commitment that one eligible Work item snapshot owns
one new Run. Concurrent attempts for the same snapshot resolve to the admitted
Run instead of creating another Run. Eligibility is rechecked around the claim,
but JSON Work item state and the SQLite claim are not a cross-store transaction.
Terminal settlement is fenced by a durable intent and may recover an expired
owner only after the Work item projection proves that exact intent.
New admission attempts retry that proof-based recovery before reporting an
active-owner conflict. Supersession alone is not recovery proof and remains
fail-closed.

Admission initialization retains its own non-expiring durable token until the
Work item projection latch is committed. Settlement cannot take that token
over. If the initializer exits after projecting the Work item but before
committing the latch, an operator must explicitly release or repair the owner;
automatic recovery intentionally remains fail-closed.

**Run continuation claim**

The durable, non-expiring single-owner claim required to resume an existing
blocked Run. A resumed runner can write events, mutate its worktree, and publish
changes before returning, so wall-clock expiry cannot safely fence it. Normal
completion releases the claim. A crashed owner remains fail-closed until an
operator confirms that its process is gone and explicitly releases the claim.

**Run**

A recorded execution of a Work item through a Flow.

**Artifact**

A named input or output consumed or produced by a Run, with provenance that
makes it traceable.

**Materialized Artifact**

An Artifact whose content has been captured for use by a Run.

**Run-owned content**

File content whose identity and lifetime belong exclusively to one Run. A
Run-owned file must not traverse a symbolic link and must have exactly one
directory entry (`nlink === 1`).

The Run-owned filesystem boundary requires Linux descriptor-relative path
anchoring. Platforms without that primitive fail closed instead of offering a
weaker ownership guarantee.

**Run-owned Artifact**

A Materialized Artifact backed by Run-owned content.
