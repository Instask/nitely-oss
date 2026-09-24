# Review Verdict Gate — Technical Design

The existing review-gate execution path already owns output discovery,
redaction, artifact registration, retry/rework policy, and publish ordering.
Keep those seams and make the parser authoritative at the point where the
review artifact is read.

`src/run/review-verdict.ts` recognizes the canonical `pass`/`fail` contract,
keeps legacy verdict aliases, and captures `reworkTarget`. `readReviewGateOutput`
fails closed when no recognized verdict is present. `reviewGateVerdictRecommendation`
translates a failed review into the existing `decideStagePolicy` request; the
graph still validates the target and the target stage's `maxAttempts` remains
the hard bound.

No new flow expression language or publish-specific guard is needed: publish
is already downstream of the review artifact edge and only executes after the
review stage completes.
