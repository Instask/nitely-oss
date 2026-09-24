# Sample Review Feedback

Review found one blocking issue: the reflection finalizer records a synthetic
stage ID in the run projection. Update the implementation so reflection
artifacts are attributed to the finalizer producer without creating a fake
stage in projected run state.
