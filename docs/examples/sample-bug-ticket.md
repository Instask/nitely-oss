# Sample Bug Ticket

The task detail page does not show the retry reason after a run resumes from a
blocked stage. Reproduce by opening a run with a prior blocker and confirming
that the projected log still includes the blocker reason after resume.

Expected behavior: resumed runs keep the prior blocker reason in the run
history while allowing the next stage attempt to continue.
